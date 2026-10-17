import AsyncLock from 'async-lock';
import {default as axios, type AxiosResponse} from 'axios';
import Keyv, {type KeyvStoreAdapter} from 'keyv';
import qs from 'qs';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import {solveCaptcha} from './CaptchaSolver.js';

const lock = new AsyncLock();

const webUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0';

// Secret key used by Windscribe clients to sign the auth token, only needed if the API stops returning token_sig.
const AUTH_TOKEN_SECRET = 'if_you_copy_this_you_might_die_a_painful_death';
const apiBaseUrl = 'https://api.windscribe.com';
const webBaseUrl = 'https://windscribe.com';

function computeTokenSignature(token: string): string {
  return crypto.createHash('sha256').update(token + AUTH_TOKEN_SECRET).digest('hex');
}

function formatWindscribeBody(data: unknown): string {
  if (data && typeof data == 'object') {
    const body = data as {
      errorCode?: unknown,
      errorMessage?: unknown,
      errorDescription?: unknown,
    };
    const parts = [
      body.errorCode != null ? `errorCode=${String(body.errorCode)}` : null,
      body.errorMessage != null ? `errorMessage=${String(body.errorMessage)}` : null,
      body.errorDescription != null ? `errorDescription=${String(body.errorDescription)}` : null,
    ].filter((part): part is string => part != null);

    if (parts.length > 0) {
      return parts.join(', ');
    }
  }

  const serialized = typeof data == 'string' ? data : JSON.stringify(data);
  return serialized.length > 500 ? `${serialized.substring(0, 500)}...` : serialized;
}

function formatAxiosError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const status = error.response?.status;
  const statusText = error.response?.statusText;
  const responseDescription = error.response
    ? `status ${status}${statusText ? ` ${statusText}` : ''}: ${formatWindscribeBody(error.response.data)}`
    : error.message;

  return responseDescription;
}

function formatApiResponseError<T>(operation: string, response: AxiosResponse<T>): string {
  return `${operation} failed with status ${response.status}: ${formatWindscribeBody(response.data)}`;
}

function apiValidateStatus(status: number): boolean {
  return status < 500;
}

function isAuthError(response: AxiosResponse<ApiResponse<unknown>>): boolean {
  // 701 is Windscribe's "session invalid" error code
  return response.status == 401 || response.status == 403 || Number(response.data?.errorCode) == 701;
}

interface PortForwardingInfo {
  id: number | null;
  epfExpires: number;
  ports: number[];
}

interface ApiResponse<T> {
  errorCode?: number;
  errorMessage?: string;
  errorDescription?: string;
  data?: T;
}

type AuthTokenResponse = ApiResponse<{
  token: string;
  token_sig?: string;
  captcha?: {
    background: string;
    slider?: string;
    top: number;
    type?: string;
    ascii_art?: string;
  };
}>;

type SessionResponse = ApiResponse<{
  session_auth_hash?: string;
}>;

interface EphemeralPort {
  id?: number | string;
  ext: number | string;
  int: number | string;
  start_ts: number | string;
}

type EphPortForwardingResponse = ApiResponse<{
  success?: number;
  epf?: EphemeralPort | false;
}>;

export interface WindscribePort {
  port: number,
  announcePort: number,
  expires: Date,
}

export class WindscribeClient {

  private cache: Keyv<string>;
  private readonly totp: OTPAuth.TOTP | null = null;
  private readonly ephemeralInternalPort: number | null;

  constructor(
    private username: string | undefined,
    private password: string | undefined,
    private configuredAuthHash: string | undefined,
    cache?: KeyvStoreAdapter,
    totpSecret?: string,
    ephemeralInternalPort?: number,
  ) {
    this.cache = new Keyv({
      store: cache,
      namespace: 'windscribe',
    });
    this.ephemeralInternalPort = ephemeralInternalPort && ephemeralInternalPort > 0 ? ephemeralInternalPort : null;

    if (totpSecret) {
      this.totp = new OTPAuth.TOTP({
        issuer: 'Windscribe',
        label: username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: totpSecret,
      });
      console.log('2FA TOTP configured for Windscribe login');
    }
  }

  async updatePort(): Promise<WindscribePort> {
    // check for current status, this will also login if needed
    let portForwardingInfo = await this.getPortForwardingInfo();

    const currentInternalPort = portForwardingInfo.ports[1];
    // check for existing ports that do not match the configured request mode
    if (this.ephemeralInternalPort && portForwardingInfo.epfExpires != 0 && currentInternalPort != this.ephemeralInternalPort) {
      console.log(`Existing windscribe internal port (${currentInternalPort}) does not match configured port (${this.ephemeralInternalPort}), removing existing port`);
      await this.removeEphemeralPort(portForwardingInfo);

      // update data to match current state
      portForwardingInfo = {id: null, ports: [], epfExpires: 0};
      await this.cache.delete('port');
    } else if (!this.ephemeralInternalPort && portForwardingInfo.ports.length == 2 && portForwardingInfo.ports[0] != portForwardingInfo.ports[1]) {
      console.log('Detected mismatched ports, removing existing ports');
      await this.removeEphemeralPort(portForwardingInfo);

      // update data to match current state
      portForwardingInfo = {id: null, ports: [], epfExpires: 0};
      await this.cache.delete('port');
    }

    // request new port if we don't have any
    if (portForwardingInfo.epfExpires == 0) {
      const portRequestDescription = this.ephemeralInternalPort
        ? `specific internal ephemeral port ${this.ephemeralInternalPort}`
        : 'matching ephemeral port';
      console.log(`No windscribe port configured, requesting new ${portRequestDescription}`);
      portForwardingInfo = await this.requestEphemeralPort();
    } else {
      console.log(`Using existing windscribe ephemeral port: ${this.getTorrentPort(portForwardingInfo)}`);
    }

    const ret = {
      port: this.getTorrentPort(portForwardingInfo),
      announcePort: this.getAnnouncePort(portForwardingInfo),
      expires: new Date((portForwardingInfo.epfExpires + 86400 * 7) * 1000),
    };

    await this.cache.set('port', JSON.stringify({
      port: ret.port,
      announcePort: ret.announcePort,
    }), ret.expires.getTime() - Date.now());

    return ret;
  }

  async getPort(): Promise<WindscribePort | null> {
    const cachedPort = await this.cache.get('port', {raw: true});
    if (cachedPort == undefined) {
      return null;
    }

    const portInfo = this.parseCachedPort(cachedPort.value);
    return {
      port: portInfo.port,
      announcePort: portInfo.announcePort,
      expires: new Date(cachedPort.expires),
    };
  }

  private parseCachedPort(cachedPort: string): {port: number, announcePort: number} {
    try {
      const portInfo = JSON.parse(cachedPort) as Partial<{port: number, announcePort: number}>;
      if (typeof portInfo.port == 'number') {
        return {
          port: portInfo.port,
          announcePort: typeof portInfo.announcePort == 'number' ? portInfo.announcePort : portInfo.port,
        };
      }
    } catch {
      // Older cache entries stored only the listen port as a plain number.
    }

    const port = parseInt(cachedPort);
    return {
      port,
      announcePort: port,
    };
  }

  async debugStatus(): Promise<{epfExpires: number, ports: number[]}> {
    const portForwardingInfo = await this.getPortForwardingInfo();

    return {
      epfExpires: portForwardingInfo.epfExpires,
      ports: portForwardingInfo.ports,
    };
  }

  async signOut(): Promise<void> {
    await lock.acquire('getAuthHash', async () => {
      // a configured auth hash belongs to the user, deleting it would break their config
      if (this.configuredAuthHash) {
        return;
      }

      const authHash = await this.cache.get('authHash');
      if (authHash != undefined && await this.deleteApiSession(authHash)) {
        await this.cache.delete('authHash');
      }
    });
  }

  // returns false if the session may still be alive, so the cached value is kept and reused instead of logging in again.
  // Rate limits (429) and other rejections must not count as signed out, otherwise every run leaks another session.
  private async deleteApiSession(authHash: string): Promise<boolean> {
    try {
      const response = await axios.delete<ApiResponse<unknown>>(`${apiBaseUrl}/Session`, {
        headers: this.apiHeaders(authHash),
        validateStatus: apiValidateStatus,
      });

      if (response.status >= 200 && response.status < 300 && !response.data?.errorCode) {
        console.log('Signed out of Windscribe session');
        return true;
      }

      if (Number(response.data?.errorCode) == 701) {
        console.log(`Windscribe session was already invalid: ${formatWindscribeBody(response.data)}`);
        return true;
      }

      console.warn(`Windscribe session sign out was rejected, keeping cached auth hash to retry later: ${formatApiResponseError('Session sign out', response)}`);
      return false;
    } catch (error) {
      console.warn(`Failed to sign out of Windscribe session: ${formatAxiosError(error)}`);
      return false;
    }
  }

  private async getAuthHash(forceLogin: boolean = false): Promise<string> {
    if (this.configuredAuthHash) {
      return this.configuredAuthHash;
    }

    return lock.acquire('getAuthHash', async () => {
      if (forceLogin) {
        await this.cache.delete('authHash');
      } else {
        const cachedAuthHash = await this.cache.get('authHash');
        if (cachedAuthHash != undefined) {
          return cachedAuthHash;
        }
      }

      console.log('Invalid/missing Windscribe auth hash, logging into Windscribe API');
      const authHash = await this.login();
      await this.cache.set('authHash', authHash);
      console.log('Successfully logged into Windscribe API and cached auth hash');

      return authHash;
    });
  }

  private async login(): Promise<string> {
    if (!this.username || !this.password) {
      throw new Error('WINDSCRIBE_USERNAME and WINDSCRIBE_PASSWORD are required when WINDSCRIBE_AUTH_HASH is not set');
    }

    try {
      let captchaSolution: { offset: number; trail: { x: number[]; y: number[] } } | null = null;
      const authToken = await this.fetchAuthToken();

      if (authToken.captcha?.background) {
        console.log('CAPTCHA challenge received from Windscribe API, attempting to solve...');
        captchaSolution = await solveCaptcha({
          background: authToken.captcha.background,
          slider: authToken.captcha.slider,
          top: authToken.captcha.top,
        });
        console.log(`CAPTCHA solved: offset=${captchaSolution.offset}`);
      } else if (authToken.captcha?.ascii_art) {
        throw new Error('Windscribe returned an ASCII CAPTCHA, which cannot be solved non-interactively');
      }

      const loginData: Record<string, unknown> = {
        username: this.username,
        password: this.password,
        session_type_id: 1,
        platform: 'legacy-web',
        secure_token: authToken.token,
        secure_token_sig: authToken.token_sig ?? computeTokenSignature(authToken.token),
      };

      if (this.totp) {
        loginData['2fa_code'] = this.totp.generate();
      }

      if (captchaSolution) {
        loginData.captcha_solution = Math.round(captchaSolution.offset);
        loginData.captcha_trail = {
          x: captchaSolution.trail.x.map(x => Math.round(x)),
          y: captchaSolution.trail.y.map(y => Math.round(y)),
        };
      }

      const sessionResponse = await axios.post<SessionResponse>(`${apiBaseUrl}/Session`, loginData, {
        headers: this.apiHeaders('anonymous', 'application/json'),
        validateStatus: apiValidateStatus,
      });

      if (sessionResponse.status >= 400) {
        throw new Error(formatApiResponseError('Session login', sessionResponse));
      }

      if (sessionResponse.data.errorCode) {
        throw new Error(`Session error: ${formatWindscribeBody(sessionResponse.data)}`);
      }

      const authHash = sessionResponse.data.data?.session_auth_hash;
      if (!authHash) {
        throw new Error('No session_auth_hash in Windscribe API login response');
      }

      return authHash;
    } catch (error) {
      throw new Error(`Failed to log into Windscribe API: ${formatAxiosError(error)}`);
    }
  }

  private async fetchAuthToken(): Promise<NonNullable<AuthTokenResponse['data']>> {
    const authResponse = await axios.post<AuthTokenResponse>(`${apiBaseUrl}/AuthToken/login`, {
      username: this.username,
      password: this.password,
    }, {
      headers: this.apiHeaders('anonymous', 'application/json'),
      validateStatus: apiValidateStatus,
    });

    if (authResponse.status >= 400) {
      throw new Error(formatApiResponseError('Auth token request', authResponse));
    }

    if (authResponse.data.errorCode) {
      throw new Error(`Auth token error: ${formatWindscribeBody(authResponse.data)}`);
    }

    if (!authResponse.data.data?.token) {
      throw new Error('No token in auth response');
    }

    return authResponse.data.data;
  }

  private apiHeaders(authHash: string, contentType?: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${authHash}`,
      'User-Agent': webUserAgent,
      'Accept': '*/*',
      'Origin': webBaseUrl,
      'Referer': `${webBaseUrl}/`,
      ...(contentType ? {'Content-Type': contentType} : {}),
    };
  }

  // runs an EphPortForwarding request, logging in again once if the cached auth hash was rejected
  private async ephPortForwardingRequest(
    operation: string,
    method: 'GET' | 'POST' | 'DELETE',
    fields: Record<string, string | number | undefined> = {},
  ): Promise<NonNullable<EphPortForwardingResponse['data']>> {
    const send = async (authHash: string) => axios.request<EphPortForwardingResponse>({
      url: `${apiBaseUrl}/EphPortForwarding`,
      method,
      headers: this.apiHeaders(authHash, method == 'GET' ? undefined : 'application/x-www-form-urlencoded'),
      data: method == 'GET' ? undefined : qs.stringify({session_auth_hash: authHash, ...fields}),
      validateStatus: apiValidateStatus,
    });

    let response = await send(await this.getAuthHash());
    if (isAuthError(response)) {
      if (this.configuredAuthHash) {
        throw new Error(`${operation}: configured WINDSCRIBE_AUTH_HASH was rejected: ${formatWindscribeBody(response.data)}`);
      }
      console.warn(`Cached Windscribe auth hash was rejected, logging in again: ${formatWindscribeBody(response.data)}`);
      response = await send(await this.getAuthHash(true));
    }

    if (response.status >= 400) {
      throw new Error(formatApiResponseError(operation, response));
    }

    if (response.data?.errorCode) {
      throw new Error(`${operation} error: ${formatWindscribeBody(response.data)}`);
    }

    if (!response.data?.data) {
      throw new Error(`${operation}: no data in response: ${formatWindscribeBody(response.data)}`);
    }

    return response.data.data;
  }

  private parseEphemeralPort(epf: EphemeralPort | false | undefined): PortForwardingInfo {
    if (!epf) {
      return {id: null, epfExpires: 0, ports: []};
    }

    return {
      id: epf.id != null ? +epf.id : null,
      epfExpires: +epf.start_ts,
      ports: [+epf.ext, +epf.int],
    };
  }

  private async getPortForwardingInfo(): Promise<PortForwardingInfo> {
    try {
      const data = await this.ephPortForwardingRequest('Get ephemeral port', 'GET');
      return this.parseEphemeralPort(data.epf);
    } catch (error) {
      throw new Error(`Failed to get port forwarding info: ${formatAxiosError(error)}`);
    }
  }

  private async removeEphemeralPort(portForwardingInfo: PortForwardingInfo): Promise<void> {
    try {
      // the web app falls back to the external port when the API does not return an id
      const id = portForwardingInfo.id ?? portForwardingInfo.ports[0];
      const data = await this.ephPortForwardingRequest('Delete ephemeral port', 'DELETE', {id});

      if (data.success == 0) {
        throw new Error('success = 0');
      }

      if (data.epf === false) {
        console.warn('Tried to remove a non-existent ephemeral port, ignoring');
      } else {
        console.log('Deleted ephemeral port');
      }
    } catch (error) {
      throw new Error(`Failed to delete ephemeral port: ${formatAxiosError(error)}`);
    }
  }

  private getTorrentPort(portForwardingInfo: PortForwardingInfo): number {
    return portForwardingInfo.ports[1] ?? portForwardingInfo.ports[0];
  }

  private getAnnouncePort(portForwardingInfo: PortForwardingInfo): number {
    return this.ephemeralInternalPort ? portForwardingInfo.ports[0] : this.getTorrentPort(portForwardingInfo);
  }

  private async requestEphemeralPort(): Promise<PortForwardingInfo> {
    try {
      // omitting the port requests a matching port
      const data = await this.ephPortForwardingRequest('Request ephemeral port', 'POST', {
        port: this.ephemeralInternalPort ?? undefined,
      });

      if (data.success == 0 || !data.epf) {
        throw new Error(`no port returned: ${formatWindscribeBody(data)}`);
      }

      const portForwardingInfo = this.parseEphemeralPort(data.epf);
      const [ext, int] = portForwardingInfo.ports;
      if (this.ephemeralInternalPort) {
        console.log(`Created new specific ephemeral port: internal ${int}, external ${ext}`);
      } else {
        console.log(`Created new matching ephemeral port: ${ext}`);
      }
      return portForwardingInfo;
    } catch (error) {
      const portRequestDescription = this.ephemeralInternalPort ? 'specific ephemeral port' : 'matching ephemeral port';
      throw new Error(`Failed to request ${portRequestDescription}: ${error instanceof Error ? error.message : error}`);
    }
  }

}
