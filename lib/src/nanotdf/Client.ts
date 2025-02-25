import type { TypedArray } from '../tdf/index';
import * as base64 from '../encodings/base64';
import {
  authToken,
  cryptoPublicToPem,
  decrypt,
  enums as cryptoEnums,
  generateKeyPair,
  importRawKey,
  keyAgreement,
  pemPublicToCrypto,
} from '../nanotdf-crypto/index';
import getHkdfSalt from './helpers/getHkdfSalt';
import DefaultParams from './models/DefaultParams';
import { fetchWrappedKey } from '../kas';
import { AuthProvider } from '../auth/providers';

const { KeyUsageType, AlgorithmName, NamedCurve } = cryptoEnums;

/**
 * A Client encapsulates sessions interacting with TDF3 and nanoTDF backends, KAS and any
 * plugin-based sessions like identity and further attribute control. Most importantly, it is responsible
 * for local key and token management, including the ephemeral public/private keypairs
 * used for encrypting and decrypting information.
 *
 * @link https://developer.mozilla.org/en-US/docs/Web/API/CryptoKeyPair
 *
 * @example
 * import { Client, clientAuthProvider, decrypt, encrypt } from '@opentdf/client/nanotdf`
 *
 * const OIDC_ENDPOINT = 'http://localhost:65432/auth/';
 * const KAS_URL = 'http://localhost:65432/kas';
 *
 * let client = new Client(
 *    await clientAuthProvider({
 *      clientId: 'tdf-client',
 *      clientSecret: '123-456',
 *      oidcOrigin: OIDC_ENDPOINT,
 *    }),
 *    KAS_URL
 *  );
 *
 * // t=1
 * let nanoTDFEncrypted = await encrypt('some string', client.unwrappedKey);
 * let nanoTDFDecrypted = await decrypt(nanoTDFEncrypted, client.unwrappedKey);
 * nanoTDFDecrypted.toString() // 'some string'
 *
 */
export default class Client {
  static readonly KEY_ACCESS_REMOTE = 'remote';
  static readonly KAS_PROTOCOL = 'kas';
  static readonly SDK_INITIAL_RELEASE = '0.0.0';
  static readonly INITIAL_RELEASE_IV_SIZE = 3;
  static readonly IV_SIZE = 12;

  /*
    These variables are expected to be either assigned during initialization or within the methods.
    This is needed as the flow is very specific. Errors should be thrown if the necessary step is not completed.
  */
  protected kasUrl: string;
  protected kasPubKey: string;
  readonly authProvider: AuthProvider;
  dissems: string[] = [];
  dataAttributes: string[] = [];
  protected ephemeralKeyPair?: Required<Readonly<CryptoKeyPair>>;
  protected requestSignerKeyPair?: Required<Readonly<CryptoKeyPair>>;
  protected iv?: number;

  /**
   * Create new NanoTDF Client
   *
   * The Ephemeral Key Pair can either be provided or will be generate when fetching the entity object. Once set it
   * cannot be changed. If a new ephemeral key is desired it a new client should be initialized.
   * There is no performance impact for creating a new client IFF the ephemeral key pair is provided.
   */
  constructor(
    authProvider: AuthProvider,
    kasUrl: string,
    ephemeralKeyPair?: Required<Readonly<CryptoKeyPair>>
  ) {
    this.authProvider = authProvider;
    this.kasUrl = kasUrl;
    this.kasPubKey = '';

    if (ephemeralKeyPair) {
      this.ephemeralKeyPair = ephemeralKeyPair;
      this.iv = 1;
    }
  }

  /**
   * Get ephemeral key pair
   *
   * Returns the ephemeral key pair to be used in other clients or undefined if not set or generated
   *
   * @security allow returning ephemeral key pair has unknown security risks.
   */
  getEphemeralKeyPair(): CryptoKeyPair | undefined {
    return this.ephemeralKeyPair;
  }

  async generateEphemeralKeyPair(): Promise<Required<Readonly<CryptoKeyPair>>> {
    const { publicKey, privateKey } = await generateKeyPair();
    if (!privateKey || !publicKey) {
      throw Error('Key pair generation failed');
    }
    this.ephemeralKeyPair = { publicKey, privateKey };
    this.iv = 1;
    return { publicKey, privateKey };
  }

  async generateSignerKeyPair(): Promise<Required<Readonly<CryptoKeyPair>>> {
    const { publicKey, privateKey } = await generateKeyPair({
      type: AlgorithmName.ECDSA,
      curve: NamedCurve.P256,
      keyUsages: [KeyUsageType.Sign, KeyUsageType.Verify],
      isExtractable: true,
    });
    if (!privateKey || !publicKey) {
      throw Error('Signer key pair generation failed');
    }
    this.requestSignerKeyPair = { publicKey, privateKey };
    return { publicKey, privateKey };
  }

  /**
   * Add attribute to the TDF file/data
   *
   * @param attribute The attribute that decides the access control of the TDF.
   */
  addAttribute(attribute: string): void {
    this.dataAttributes.push(attribute);
  }

  /**
   * Explicitly get a new Entity Object using the supplied EntityAttributeService.
   *
   * This method is expected to be called at least once per encrypt/decrypt cycle. If the entityObject is expired then
   * this will need to be called again.
   *
   * @security the ephemeralKeyPair must be set in the constructor if desired to use here. If this is wished to be changed
   * then a new client should be initialized.
   * @performance key pair is generated when the entity object is fetched IFF the ephemeralKeyPair is not set. This will
   * either be set on the first call or passed in the constructor.
   */
  async fetchOIDCToken(): Promise<void> {
    // Generate the ephemeral key pair if not set
    const promises: Promise<Required<Readonly<CryptoKeyPair>>>[] = [];
    if (!this.ephemeralKeyPair) {
      promises.push(this.generateEphemeralKeyPair());
    }

    if (!this.requestSignerKeyPair) {
      promises.push(this.generateSignerKeyPair());
    }
    await Promise.all(promises);

    const signer = this.requestSignerKeyPair;
    if (!signer) {
      throw new Error('Unexpected state');
    }

    const signerPubKey = await cryptoPublicToPem(signer.publicKey);
    await this.authProvider.updateClientPublicKey(base64.encode(signerPubKey));
  }

  /**
   * Rewrap key
   *
   * @important the `fetchEntityObject` method must be called prior to
   * @param nanoTdfHeader the full header for the nanotdf
   * @param kasRewrapUrl key access server's rewrap endpoint
   * @param magicNumberVersion nanotdf container version
   * @param clientVersion version of the client, as SemVer
   * @param authTagLength number of bytes to keep in the authTag
   */
  async rewrapKey(
    nanoTdfHeader: TypedArray | ArrayBuffer,
    kasRewrapUrl: string,
    magicNumberVersion: TypedArray | ArrayBuffer,
    clientVersion: string,
    authTagLength: number
  ): Promise<CryptoKey> {
    // Ensure the ephemeral key pair has been set or generated (see createOidcServiceProvider)
    await this.fetchOIDCToken();

    // Ensure the ephemeral key pair has been set or generated (see fetchEntityObject)
    if (!this.ephemeralKeyPair?.privateKey) {
      throw new Error('Ephemeral key has not been set or generated');
    }

    if (!this.requestSignerKeyPair?.privateKey) {
      throw new Error('Signer key has not been set or generated');
    }

    try {
      const requestBodyStr = JSON.stringify({
        algorithm: DefaultParams.defaultECAlgorithm,
        // nano keyAccess minimum, header is used for nano
        keyAccess: {
          type: Client.KEY_ACCESS_REMOTE,
          url: '',
          protocol: Client.KAS_PROTOCOL,
          header: base64.encodeArrayBuffer(nanoTdfHeader),
        },
        clientPublicKey: await cryptoPublicToPem(this.ephemeralKeyPair.publicKey),
      });

      const jwtPayload = { requestBody: requestBodyStr };
      const requestBody = {
        signedRequestToken: await authToken(this.requestSignerKeyPair.privateKey, jwtPayload),
      };

      const authHeader = await this.authProvider.authorization(); // authHeader is a string of the form "Bearer token"

      // Wrapped
      const wrappedKey = await fetchWrappedKey(
        kasRewrapUrl,
        requestBody,
        authHeader,
        clientVersion
      );

      // Extract the iv and ciphertext
      const entityWrappedKey = new Uint8Array(
        base64.decodeArrayBuffer(wrappedKey.entityWrappedKey)
      );
      const ivLength =
        clientVersion == Client.SDK_INITIAL_RELEASE
          ? Client.INITIAL_RELEASE_IV_SIZE
          : Client.IV_SIZE;
      const iv = entityWrappedKey.subarray(0, ivLength);
      const encryptedSharedKey = entityWrappedKey.subarray(ivLength);

      let publicKey;
      try {
        // Get session public key as crypto key
        publicKey = await pemPublicToCrypto(wrappedKey.sessionPublicKey);
      } catch (e) {
        throw new Error(
          `PEM Public Key to crypto public key failed. Is PEM formatted correctly?\n Caused by: ${e.message}`
        );
      }

      let hkdfSalt;
      try {
        // Get the hkdf salt params
        hkdfSalt = await getHkdfSalt(magicNumberVersion);
      } catch (e) {
        throw new Error(`Salting hkdf failed\n Caused by: ${e.message}`);
      }

      // Get the unwrapping key
      const unwrappingKey = await keyAgreement(
        // Ephemeral private key
        this.ephemeralKeyPair.privateKey,
        publicKey,
        hkdfSalt
      );

      let decryptedKey;
      try {
        // Decrypt the wrapped key
        decryptedKey = await decrypt(unwrappingKey, encryptedSharedKey, iv, authTagLength);
      } catch (e) {
        throw new Error(
          `Unable to decrypt key. Are you using the right KAS? Is the salt correct?\n Caused by: ${e.message}`
        );
      }

      // UnwrappedKey
      let unwrappedKey;
      try {
        unwrappedKey = await importRawKey(
          decryptedKey,
          // Want to use the key to encrypt and decrypt. Signing key will be used later.
          [KeyUsageType.Encrypt, KeyUsageType.Decrypt],
          // @security This allows the key to be used in `exportKey` and `wrapKey`
          // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/exportKey
          // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/wrapKey
          true
        );
      } catch (e) {
        throw new Error(`Unable to import raw key.\n Caused by: ${e.message}`);
      }

      return unwrappedKey;
    } catch (e) {
      throw new Error(`Could not rewrap key with entity object.\n Caused by: ${e.message}`);
    }
  }
}
