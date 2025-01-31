/**
 * @dev Simplifies interaction with the Umbra contracts
 */

import {
  AddressZero,
  arrayify,
  BigNumber,
  BigNumberish,
  Contract,
  ContractTransaction,
  defaultAbiCoder,
  getAddress,
  hexlify,
  isHexString,
  JsonRpcSigner,
  keccak256,
  Overrides,
  sha256,
  splitSignature,
  toUtf8Bytes,
  Wallet,
} from '../ethers';
import { KeyPair } from './KeyPair';
import { RandomNumber } from './RandomNumber';
import { blockedStealthAddresses, lookupRecipient } from '../utils/utils';
import { Umbra as UmbraContract, Erc20 as ERC20 } from '@umbra/contracts/typechain';
import { ERC20_ABI } from '../utils/constants';
import type { Announcement, ChainConfig, EthersProvider, ScanOverrides, SendOverrides, SubgraphAnnouncement, UserAnnouncement } from '../types'; // prettier-ignore

// Umbra.sol ABI
const { abi } = require('@umbra/contracts/artifacts/contracts/Umbra.sol/Umbra.json');

// Mapping from chainId to contract information
const umbraAddress = '0xFb2dc580Eed955B528407b4d36FfaFe3da685401'; // same on all supported networks
const subgraphs = {
  1: 'https://api.thegraph.com/subgraphs/name/scopelift/umbramainnet',
  4: 'https://api.thegraph.com/subgraphs/name/scopelift/umbrarinkeby',
  137: 'https://api.thegraph.com/subgraphs/name/scopelift/umbrapolygon',
};

const chainConfigs: Record<number, ChainConfig> = {
  1: { chainId: 1, umbraAddress, startBlock: 12343914, subgraphUrl: subgraphs[1] }, // Mainnet
  4: { chainId: 4, umbraAddress, startBlock: 8505089, subgraphUrl: false }, // Rinkeby Graph disabled due to outage/issues
  137: { chainId: 137, umbraAddress, startBlock: 20717318, subgraphUrl: subgraphs[137] }, // Polygon
  1337: { chainId: 1337, umbraAddress, startBlock: 8505089, subgraphUrl: false }, // Local
};

/**
 * @notice Helper method to parse chainConfig input and return a valid chain configuration
 * @param chainConfig Supported chainID as number, or custom ChainConfig
 */
const parseChainConfig = (chainConfig: ChainConfig | number) => {
  if (!chainConfig) {
    throw new Error('chainConfig not provided');
  }

  // If a number is provided, verify chainId value is value and pull config from `chainConfigs`
  if (typeof chainConfig === 'number') {
    const validChainIds = Object.keys(chainConfigs);
    if (validChainIds.includes(String(chainConfig))) {
      return chainConfigs[chainConfig];
    }
    throw new Error('Unsupported chain ID provided');
  }

  // Otherwise verify the user's provided chain config is valid and return it
  const { chainId, startBlock, subgraphUrl, umbraAddress } = chainConfig;
  const isValidStartBlock = typeof startBlock === 'number' && startBlock >= 0;

  if (!isValidStartBlock) {
    throw new Error(`Invalid start block provided in chainConfig. Got '${startBlock}'`);
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
    throw new Error(`Invalid chainId provided in chainConfig. Got '${chainId}'`);
  }
  if (subgraphUrl !== false && typeof subgraphUrl !== 'string') {
    throw new Error(`Invalid subgraphUrl provided in chainConfig. Got '${subgraphUrl}'`);
  }

  return { umbraAddress: getAddress(umbraAddress), startBlock, chainId, subgraphUrl };
};

/**
 * @notice Helper method to determine if the provided address is a token or ETH
 * @param token Token address, where both 'ETH' and '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' return true
 */
const isEth = (token: string) => {
  if (token === 'ETH') {
    return true;
  }
  return getAddress(token) === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // throws if `token` is not a valid address
};

export class Umbra {
  readonly chainConfig: ChainConfig;
  readonly umbraContract: UmbraContract;

  // ========================================= CONSTRUCTOR =========================================
  /**
   * @notice Create Umbra instance to interact with the Umbra contracts
   * @param provider ethers provider to use
   * @param chainConfig The chain configuration of the network or a network ID to use a default one
   */
  constructor(readonly provider: EthersProvider, chainConfig: ChainConfig | number) {
    this.chainConfig = parseChainConfig(chainConfig);
    this.umbraContract = new Contract(this.chainConfig.umbraAddress, abi, provider) as UmbraContract;
  }

  // ==================================== CONTRACT INTERACTION =====================================

  /**
   * @notice Returns a signer with a valid provider
   * @param signer Signer that may or may not have an associated provider
   */
  getConnectedSigner(signer: JsonRpcSigner | Wallet) {
    return signer.provider ? signer : signer.connect(this.provider);
  }

  /**
   * @notice Send funds to a recipient via Umbra
   * @dev If sending tokens, make sure to handle the approvals before calling this method
   * @dev The provider used for sending the transaction is the one associated with the Umbra instance
   * @dev Fetching the latest toll and including that value on top of `amount` is automatically handled
   * @param signer Signer to send transaction from
   * @param token Address of token to send, excluding toll. Use 'ETH' or '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
   * to send Ether
   * @param amount Amount to send, in units of that token (e.g. use 1e6 to send 1 USDC)
   * @param recipientId Identifier of recipient, e.g. their ENS name
   * @param overrides Override the gas limit, gas price, nonce, or advanced mode.
   * When `advanced` is false it looks for public keys in StealthKeyRegistry, and when true it recovers
   * them from on-chain transaction when true
   */
  async send(
    signer: JsonRpcSigner | Wallet,
    token: string,
    amount: BigNumberish,
    recipientId: string,
    overrides: SendOverrides = {}
  ) {
    // Configure signer
    const txSigner = this.getConnectedSigner(signer); // signer input validated

    // If applicable, check that sender has sufficient token balance. ETH balance is checked on send. The isEth
    // method also serves to validate the token input
    if (!isEth(token)) {
      const tokenContract = new Contract(token, ERC20_ABI, signer) as ERC20;
      const tokenBalance = await tokenContract.balanceOf(await signer.getAddress());
      if (tokenBalance.lt(amount)) {
        const providedAmount = BigNumber.from(amount).toString();
        const details = `Has ${tokenBalance.toString()} tokens, tried to send ${providedAmount} tokens.`;
        throw new Error(`Insufficient balance to complete transfer. ${details}`);
      }
    }

    // Get toll amount from contract
    const toll = await this.umbraContract.toll();

    // Parse provided overrides
    const localOverrides = { ...overrides }; // avoid mutating the object passed in
    const advanced = localOverrides?.advanced || false;
    const supportPubKey = localOverrides?.supportPubKey || false;
    const supportTxHash = localOverrides?.supportTxHash || false;
    const lookupOverrides = { advanced, supportPubKey, supportTxHash };

    delete localOverrides.advanced;
    delete localOverrides.supportPubKey;
    delete localOverrides.supportTxHash;

    // Lookup recipient's public key
    const { spendingPublicKey, viewingPublicKey } = await lookupRecipient(recipientId, this.provider, lookupOverrides);
    if (!spendingPublicKey || !viewingPublicKey) {
      throw new Error(`Could not retrieve public keys for recipient ID ${recipientId}`);
    }
    const spendingKeyPair = new KeyPair(spendingPublicKey);
    const viewingKeyPair = new KeyPair(viewingPublicKey);

    // Generate random number
    const randomNumber = new RandomNumber();

    // Encrypt random number with recipient's public key
    const encrypted = viewingKeyPair.encrypt(randomNumber);

    // Get x,y coordinates of ephemeral private key
    const { pubKeyXCoordinate } = KeyPair.compressPublicKey(encrypted.ephemeralPublicKey);

    // Compute stealth address
    const stealthKeyPair = spendingKeyPair.mulPublicKey(randomNumber);

    // Ensure that the stealthKeyPair's address is not on the block list
    if (blockedStealthAddresses.includes(stealthKeyPair.address)) throw new Error('Invalid stealth address');

    // Send transaction
    let tx: ContractTransaction;
    if (isEth(token)) {
      const txOverrides = { ...localOverrides, value: toll.add(amount) };
      tx = await this.umbraContract
        .connect(txSigner)
        .sendEth(stealthKeyPair.address, toll, pubKeyXCoordinate, encrypted.ciphertext, txOverrides);
    } else {
      const txOverrides = { ...localOverrides, value: toll };
      tx = await this.umbraContract
        .connect(txSigner)
        .sendToken(stealthKeyPair.address, token, amount, pubKeyXCoordinate, encrypted.ciphertext, txOverrides);
    }

    // We do not wait for the transaction to be mined before returning it
    return { tx, stealthKeyPair };
  }

  /**
   * @notice Withdraw ETH or tokens to a specified destination address with a regular transaction
   * @dev The provider used for sending the transaction is the one associated with the Umbra instance
   * @dev This method does not relay meta-transactions and requires signer to have ETH
   * @param spendingPrivateKey Receiver's spending private key
   * @param token Address of token to withdraw,
   * @param destination Address where funds will be withdrawn to
   * @param overrides Override the gas limit, gas price, or nonce
   */
  async withdraw(spendingPrivateKey: string, token: string, destination: string, overrides: Overrides = {}) {
    // Address input validations
    // token === 'ETH' is valid so we don't verify that, and let ethers verify it during the function call
    destination = getAddress(destination);

    // Configure signer
    const stealthWallet = new Wallet(spendingPrivateKey); // validates spendingPrivateKey input
    const txSigner = this.getConnectedSigner(stealthWallet);

    // Handle ETH and tokens accordingly. The isEth method also serves to validate the token input
    if (isEth(token)) {
      // Withdraw ETH
      // Based on gas price, compute how much ETH to transfer to avoid dust
      const ethBalance = await this.provider.getBalance(stealthWallet.address); // stealthWallet.address is our stealthAddress
      const gasPrice = BigNumber.from(overrides.gasPrice || (await this.provider.getGasPrice()));
      const gasLimit = BigNumber.from(overrides.gasLimit || '21000');
      const txCost = gasPrice.mul(gasLimit);
      if (txCost.gt(ethBalance)) {
        throw new Error('Stealth address ETH balance is not enough to pay for withdrawal gas cost');
      }
      return txSigner.sendTransaction({
        to: destination,
        value: ethBalance.sub(txCost),
        gasPrice,
        gasLimit,
        nonce: overrides.nonce || undefined, // nonce will be determined by ethers if undefined
      });
    } else {
      // Withdrawing a token
      return await this.umbraContract.connect(txSigner).withdrawToken(destination, token, overrides);
    }
  }

  /**
   * @notice Withdraw tokens by sending a meta-transaction on behalf of a user
   * @dev The provider used for sending the transaction is the one associated with the Umbra instance
   * @dev This method does not relay meta-transactions and requires signer to have ETH
   * @param signer Signer to send transaction from
   * @param stealthAddr Stealth address funds were sent to
   * @param destination Address where funds will be withdrawn to
   * @param token Address of token to withdraw
   * @param sponsor Address that receives sponsorFee
   * @param sponsorFee Fee for relayer
   * @param v v-component of signature
   * @param r r-component of signature
   * @param s s-component of signature
   * @param overrides Override the gas limit, gas price, or nonce
   */
  async withdrawOnBehalf(
    signer: JsonRpcSigner | Wallet,
    stealthAddr: string,
    destination: string,
    token: string,
    sponsor: string,
    sponsorFee: BigNumberish,
    v: number,
    r: string,
    s: string,
    overrides: Overrides = {}
  ) {
    // Address input validations
    stealthAddr = getAddress(stealthAddr);
    destination = getAddress(destination);
    token = getAddress(token);
    sponsor = getAddress(sponsor);

    // Send withdraw transaction
    const txSigner = this.getConnectedSigner(signer);
    return await this.umbraContract
      .connect(txSigner)
      .withdrawTokenOnBehalf(stealthAddr, destination, token, sponsor, sponsorFee, v, r, s, overrides);
  }

  /**
   * @notice Withdraw tokens by relaying a user's meta-transaction
   */
  async relayWithdrawOnBehalf() {
    // TODO
  }

  /**
   * @notice Scans Umbra event logs for funds sent to the specified address
   * @param spendingPublicKey Receiver's spending private key
   * @param viewingPrivateKey Receiver's viewing public key
   * @param overrides Override the start and end block used for scanning
   */
  async scan(spendingPublicKey: string, viewingPrivateKey: string, overrides: ScanOverrides = {}) {
    // Get start and end blocks to scan events for
    const startBlock = overrides.startBlock || this.chainConfig.startBlock;
    const endBlock = overrides.endBlock || 'latest';

    // Try querying events using the Graph, fallback to querying logs.
    // The Graph fetching uses the browser's `fetch` method to query the subgraph, so we check
    // that window is defined first to avoid trying to use fetch in node environments
    if (typeof window !== 'undefined' && this.chainConfig.subgraphUrl) {
      try {
        // Query subgraph
        const subgraphAnnouncements: SubgraphAnnouncement[] = await recursiveGraphFetch(
          this.chainConfig.subgraphUrl,
          'announcementEntities',
          (filter: string) => `{
            announcementEntities(${filter}) {
              amount
              block
              ciphertext
              from
              id
              pkx
              receiver
              timestamp
              token
              txHash
            }
          }`
        );

        // Determine which announcements are for the user.
        // First we map the subgraph amount field from string to BigNumber, then we reduce the array to the
        // subset of announcements for the user
        const announcements = subgraphAnnouncements.map((x) => ({ ...x, amount: BigNumber.from(x.amount) }));
        const userAnnouncements = announcements.reduce((userAnns, ann) => {
          const { amount, from, receiver, timestamp, token: tokenAddr, txHash } = ann;
          const { isForUser, randomNumber } = isAnnouncementForUser(spendingPublicKey, viewingPrivateKey, ann);
          const token = getAddress(tokenAddr); // ensure checksummed address
          const isWithdrawn = false; // we always assume not withdrawn and leave it to the caller to check
          if (isForUser) userAnns.push({ randomNumber, receiver, amount, token, from, txHash, timestamp, isWithdrawn });
          return userAnns;
        }, [] as UserAnnouncement[]);

        // Filtering and parsing done, return announcements
        return { userAnnouncements };
      } catch (err) {
        // Graph query failed, try requesting logs directly IF we are not on polygon. If we are on
        // Polygon, there isn't much we can do, so for now just show a warning and return an empty array
        if (this.chainConfig.chainId === 137) {
          console.warn('Cannot fetch Announcements from logs on Polygon, please try again later');
          return { userAnnouncements: [] };
        }
        const userAnnouncements = await this.userAnnouncementsFromLogs(spendingPublicKey, viewingPrivateKey, startBlock, endBlock); // prettier-ignore
        return { userAnnouncements };
      }
    }

    // Subgraph not available, try requesting logs directly IF we are not on Polygon. If we are on
    // Polygon, there isn't much we can do, so for now just show a warning and return an empty array
    if (this.chainConfig.chainId === 137) {
      console.warn('Cannot fetch Announcements from logs on Polygon, please try again later');
      return { userAnnouncements: [] };
    }
    const userAnnouncements = await this.userAnnouncementsFromLogs(spendingPublicKey, viewingPrivateKey, startBlock, endBlock); // prettier-ignore
    return { userAnnouncements };
  }

  // ======================================= HELPER METHODS ========================================

  /**
   * @notice Queries the node for logs, and returns the set of Announcements that were intended for the specified user
   * @param spendingPublicKey Receiver's spending private key
   * @param viewingPrivateKey Receiver's viewing public key
   * @param startBlock Block to start scanning from
   * @param endBlock Block to scan until
   */
  async userAnnouncementsFromLogs(
    spendingPublicKey: string,
    viewingPrivateKey: string,
    startBlock: string | number,
    endBlock: string | number
  ): Promise<UserAnnouncement[]> {
    // Get list of all Announcement events
    const announcementFilter = this.umbraContract.filters.Announcement(null, null, null, null, null);
    const announcements = await this.umbraContract.queryFilter(announcementFilter, startBlock, endBlock);

    const userAnnouncements = await Promise.all(
      announcements.map(async (event) => {
        // Extract out event parameters
        const announcement = (event.args as unknown) as Announcement;
        const { receiver, amount, token } = announcement;
        const { isForUser, randomNumber } = isAnnouncementForUser(spendingPublicKey, viewingPrivateKey, announcement);

        // If  receiving address matches event's recipient, the transfer was for the user. Otherwise it wasn't,
        // so return null and filter later
        if (!isForUser) return null;
        const [block, tx] = await Promise.all([event.getBlock(), event.getTransaction()]);
        return {
          randomNumber,
          receiver,
          amount,
          token: getAddress(token),
          from: tx.from,
          txHash: event.transactionHash,
          timestamp: String(block.timestamp),
          isWithdrawn: false,
        };
      })
    );

    return userAnnouncements.filter((ann) => ann !== null) as UserAnnouncement[];
  }

  /**
   * @notice Asks a user to sign a message to generate two Umbra-specific private keys for them
   * @dev Only safe for use with wallets that implement deterministic ECDSA signatures as specified by RFC 6979 (which
   * might be all of them?)
   * @param signer Signer to sign message from
   * @returns Two KeyPair instances, for the spendingKeyPair and viewingKeyPair
   */
  async generatePrivateKeys(signer: JsonRpcSigner | Wallet) {
    // Base message that will be signed
    const baseMessage = 'Sign this message to access your Umbra account.\n\nOnly sign this message for a trusted client!'; // prettier-ignore

    // Append chain ID if not mainnet to mitigate replay attacks
    const { chainId } = await this.provider.getNetwork();
    const message = chainId === 1 ? baseMessage : `${baseMessage}\n\nChain ID: ${chainId}`;

    // Get 65 byte signature from user using personal_sign
    const userAddress = await signer.getAddress();
    const formattedMessage = hexlify(toUtf8Bytes(message));
    const signature = String(await this.provider.send('personal_sign', [formattedMessage, userAddress.toLowerCase()]));

    // If a user can no longer access funds because their wallet was using eth_sign before this update, stand up a
    // special "fund recovery login page" which uses the commented out code below to sign with eth_sign
    //     const signature = await signer.signMessage(message);

    // Verify signature
    const isValidSignature = (sig: string) => isHexString(sig) && sig.length === 132;
    if (!isValidSignature(signature)) {
      throw new Error(`Invalid signature: ${signature}`);
    }

    // Split hex string signature into two 32 byte chunks
    const startIndex = 2; // first two characters are 0x, so skip these
    const length = 64; // each 32 byte chunk is in hex, so 64 characters
    const portion1 = signature.slice(startIndex, startIndex + length);
    const portion2 = signature.slice(startIndex + length, startIndex + length + length);
    const lastByte = signature.slice(signature.length - 2);

    if (`0x${portion1}${portion2}${lastByte}` !== signature) {
      throw new Error('Signature incorrectly generated or parsed');
    }

    // Hash the signature pieces to get the two private keys
    const spendingPrivateKey = sha256(`0x${portion1}`);
    const viewingPrivateKey = sha256(`0x${portion2}`);

    // Create KeyPair instances from the private keys and return them
    const spendingKeyPair = new KeyPair(spendingPrivateKey);
    const viewingKeyPair = new KeyPair(viewingPrivateKey);
    return { spendingKeyPair, viewingKeyPair };
  }

  // ==================================== STATIC HELPER METHODS ====================================

  /**
   * @notice Helper method to return the stealth wallet from a receiver's private key and a random number
   * @param spendingPrivateKey Receiver's spending private key
   * @param randomNumber Number to multiply by, as class RandomNumber or hex string with 0x prefix
   */
  static computeStealthPrivateKey(spendingPrivateKey: string, randomNumber: RandomNumber | string) {
    const spendingPrivateKeyPair = new KeyPair(spendingPrivateKey); // validates spendingPrivateKey
    const stealthFromPrivate = spendingPrivateKeyPair.mulPrivateKey(randomNumber); // validates randomNumber
    if (!stealthFromPrivate.privateKeyHex) {
      throw new Error('Stealth key pair must have a private key: this should never occur');
    }
    return stealthFromPrivate.privateKeyHex;
  }

  /**
   * @notice Sign a transaction to be used with withdrawTokenOnBehalf
   * @dev Return type is an ethers Signature: { r: string; s: string; _vs: string, recoveryParam: number; v: number; }
   * @param spendingPrivateKey Receiver's spending private key that is doing the signing
   * @param chainId Chain ID where contract is deployed
   * @param contract Umbra contract address that withdrawal transaction will be sent to
   * @param acceptor Withdrawal destination
   * @param token Address of token to withdraw
   * @param sponsor Address of relayer
   * @param sponsorFee Amount sent to sponsor
   * @param hook Address of post withdraw hook contract
   * @param data Call data to be past to post withdraw hook
   */
  static async signWithdraw(
    spendingPrivateKey: string,
    chainId: number,
    contract: string,
    acceptor: string,
    token: string,
    sponsor: string,
    sponsorFee: BigNumberish,
    hook: string = AddressZero,
    data = '0x'
  ) {
    // Address input validations
    contract = getAddress(contract);
    acceptor = getAddress(acceptor);
    sponsor = getAddress(sponsor);
    token = getAddress(token);
    hook = getAddress(hook);

    // Validate chainId
    if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
      throw new Error(`Invalid chainId provided in chainConfig. Got '${chainId}'`);
    }

    // Validate the data string
    if (typeof data !== 'string' || !isHexString(data)) {
      throw new Error('Data string must be null or in hex format with 0x prefix');
    }

    const stealthWallet = new Wallet(spendingPrivateKey);
    const digest = keccak256(
      defaultAbiCoder.encode(
        ['uint256', 'address', 'address', 'address', 'address', 'uint256', 'address', 'bytes'],
        [chainId, contract, acceptor, token, sponsor, sponsorFee, hook, data]
      )
    );
    const rawSig = await stealthWallet.signMessage(arrayify(digest));
    return splitSignature(rawSig);
  }
}

// ============================== PRIVATE, FUNCTIONAL HELPER METHODS ==============================

/**
 * @notice Generic method to recursively grab every 'page' of results
 * @dev NOTE: the query MUST return the ID field
 * @dev Modifies from: https://github.com/dcgtc/dgrants/blob/f5a783524d0b56eea12c127b2146fba8fb9273b4/app/src/utils/utils.ts#L443
 * @dev Relevant docs: https://thegraph.com/docs/developer/graphql-api#example-3
 * @dev Lives outside of the class instance because user's should not need access to this method
 * @dev TODO support node.js by replacing reliance on browser's fetch module with https://github.com/paulmillr/micro-ftch
 * @param url the url we will recursively fetch from
 * @param key the key in the response object which holds results
 * @param query a function which will return the query string (with the page in place)
 * @param before the current array of objects
 */
async function recursiveGraphFetch(
  url: string,
  key: string,
  query: (filter: string) => string,
  before: any[] = []
): Promise<any[]> {
  // retrieve the last ID we collected to use as the starting point for this query
  const fromId = before.length ? before[before.length - 1].id : false;

  // Fetch this 'page' of results - please note that the query MUST return an ID
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: query(`
        first: 1000, 
        where: {
          ${fromId ? `id_gt: "${fromId}",` : ''}
        }
      `),
    }),
  });

  // Resolve the json
  const json = await res.json();

  // If there were results on this page then query the next page, otherwise return the data
  if (!json.data[key].length) return [...before];
  else return await recursiveGraphFetch(url, key, query, [...before, ...json.data[key]]);
}

/**
 * @notice If the provided announcement is for the user with the specified keys, return true and the decoded
 * random number
 * @param spendingPublicKey Receiver's spending private key
 * @param viewingPrivateKey Receiver's viewing public key
 * @param announcement Parameters emitted in the announcement event
 */
function isAnnouncementForUser(spendingPublicKey: string, viewingPrivateKey: string, announcement: Announcement) {
  try {
    // Get y-coordinate of public key from the x-coordinate by solving secp256k1 equation
    const { receiver, pkx, ciphertext } = announcement;
    const uncompressedPubKey = KeyPair.getUncompressedFromX(pkx);

    // Decrypt to get random number
    const payload = { ephemeralPublicKey: uncompressedPubKey, ciphertext };
    const viewingKeyPair = new KeyPair(viewingPrivateKey);
    const randomNumber = viewingKeyPair.decrypt(payload);

    // Get what our receiving address would be with this random number
    const spendingKeyPair = new KeyPair(spendingPublicKey);
    const computedReceivingAddress = spendingKeyPair.mulPublicKey(randomNumber).address;

    // If our receiving address matches the event's recipient, the transfer was for the user with the specified keys
    return { isForUser: computedReceivingAddress === getAddress(receiver), randomNumber };
  } catch (err) {
    // We may reach here if people use the sendToken method improperly, e.g. by passing an invalid pkx, so we'd
    // fail when uncompressing. For now we just silently ignore these and return false
    return { isForUser: false, randomNumber: '' };
  }
}
