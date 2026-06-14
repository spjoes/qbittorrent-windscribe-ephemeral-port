import AsyncLock from 'async-lock';
import {default as axios} from 'axios';
import Keyv, {type KeyvStoreAdapter} from 'keyv';
import {Cookie, parse as parseCookie} from 'set-cookie-parser';
import qs from 'qs';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import {solveCaptcha} from './CaptchaSolver.js';


const lock = new AsyncLock();

const appVersion = '2.16.14';
const platform = 'windows';
const userAgent = `Windscribe/${appVersion} (${platform})`;
const webUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';

// Secret key used by the desktop API client to sign the auth token.
const AUTH_TOKEN_SECRET = 'if_you_copy_this_you_might_die_a_painful_death';
const apiBaseUrl = 'https://api.windscribe.com';
const webBaseUrl = 'https://www.windscribe.com';

function computeTokenSignature(token: string): string {
  return crypto.createHash('sha256').update(token + AUTH_TOKEN_SECRET).digest('hex');
}

interface CsrfInfo {
  csrfTime: number;
  csrfToken: string;
}

interface PortForwardingInfo {
  epfExpires: number;
  ports: number[];
}

interface AuthTokenResponse {
  errorCode?: number;
  errorMessage?: string;
  data?: {
    token: string;
    captcha?: {
      background: string;
      slider?: string;
      top: number;
      type?: string;
      ascii_art?: string;
    };
  };
}

interface SessionResponse {
  errorCode?: number;
  errorMessage?: string;
  data?: {
    session_auth_hash?: string;
  };
}

interface WebSessionResponse {
  errorCode?: number;
  errorMessage?: string;
  data?: {
    temp_session?: string;
  };
}

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
    // get csrf token and time to pass on to future requests
    // this will also verify if we are logged in and login if not
    const csrfToken = await this.getMyAccountCsrfToken();

    // check for current status
    let portForwardingInfo = await this.getPortForwardingInfo();

    const currentInternalPort = portForwardingInfo.ports[1];
    // check for existing ports that do not match the configured request mode
    if (this.ephemeralInternalPort && portForwardingInfo.epfExpires != 0 && currentInternalPort != this.ephemeralInternalPort) {
      console.log(`Existing windscribe internal port (${currentInternalPort}) does not match configured port (${this.ephemeralInternalPort}), removing existing port`);
      await this.removeEphemeralPort(csrfToken);

      // update data to match current state
      portForwardingInfo.ports = [];
      portForwardingInfo.epfExpires = 0;
      await this.cache.delete('port');
    } else if (!this.ephemeralInternalPort && portForwardingInfo.ports.length == 2 && portForwardingInfo.ports[0] != portForwardingInfo.ports[1]) {
      console.log('Detected mismatched ports, removing existing ports');
      await this.removeEphemeralPort(csrfToken);

      // update data to match current state
      portForwardingInfo.ports = [];
      portForwardingInfo.epfExpires = 0;
      await this.cache.delete('port');
    }

    // request new port if we don't have any
    if (portForwardingInfo.epfExpires == 0) {
      const portRequestDescription = this.ephemeralInternalPort
        ? `specific internal ephemeral port ${this.ephemeralInternalPort}`
        : 'matching ephemeral port';
      console.log(`No windscribe port configured, requesting new ${portRequestDescription}`);
      portForwardingInfo = await this.requestEphemeralPort(csrfToken);
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

  private async getSession(forceLogin: boolean = false): Promise<string> {
    return lock.acquire('getSession', async () => {
      if (forceLogin) {
        await this.cache.delete('sessionCookie');
      } else {
        const cachedCookie = await this.cache.get('sessionCookie');
        if (cachedCookie != undefined) {
          return cachedCookie;
        }
      }

      let authHash = await this.getAuthHash();
      let sessionCookie: Cookie;
      try {
        sessionCookie = await this.createWebSession(authHash);
      } catch (error) {
        if (this.configuredAuthHash) {
          throw error;
        }
        console.warn(`Cached Windscribe auth hash was rejected, refreshing it: ${error instanceof Error ? error.message : error}`);
        authHash = await this.getAuthHash(true);
        sessionCookie = await this.createWebSession(authHash);
      }
      await this.cache.set('sessionCookie', sessionCookie.value, sessionCookie.expires.getTime() - Date.now());
      console.log(`Successfully created Windscribe web session, session expires in ${Math.floor((sessionCookie.expires.getTime() - Date.now()) / (100 * 60)) / 10} minutes`);

      return sessionCookie.value;
    });
  }

  private async getAuthHash(forceLogin: boolean = false): Promise<string> {
    if (this.configuredAuthHash) {
      return this.configuredAuthHash;
    }

    if (forceLogin) {
      await this.cache.delete('authHash');
      await this.cache.delete('sessionCookie');
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

      const secureTokenSig = computeTokenSignature(authToken.token);
      const loginData: Record<string, unknown> = {
        username: this.username,
        password: this.password,
        '2fa_code': this.totp ? this.totp.generate() : '',
        session_type_id: '3',
        secure_token: authToken.token,
        secure_token_sig: secureTokenSig,
      };

      if (captchaSolution) {
        loginData.captcha_solution = captchaSolution.offset;
        loginData.captcha_trail = {
          x: captchaSolution.trail.x,
          y: captchaSolution.trail.y,
        };
      }

      const sessionResponse = await axios.post<SessionResponse>(
        `${apiBaseUrl}/Session`,
        qs.stringify(loginData, {arrayFormat: 'indices'}),
        {
          headers: this.apiHeaders(),
          params: this.platformParams(),
        },
      );

      if (sessionResponse.data.errorCode) {
        throw new Error(`Session error (${sessionResponse.data.errorCode}): ${sessionResponse.data.errorMessage ?? 'No message'}`);
      }

      const authHash = sessionResponse.data.data?.session_auth_hash;
      if (!authHash) {
        throw new Error('No session_auth_hash in Windscribe API login response');
      }

      return authHash;
    } catch (error) {
      throw new Error(`Failed to log into Windscribe API: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async fetchAuthToken(): Promise<NonNullable<AuthTokenResponse['data']>> {
    const authResponse = await axios.post<AuthTokenResponse>(
      `${apiBaseUrl}/AuthToken/login`,
      qs.stringify({username: this.username}),
      {
        headers: this.apiHeaders(),
        params: this.platformParams(),
      },
    );

    if (authResponse.data.errorCode) {
      throw new Error(`Auth token error (${authResponse.data.errorCode}): ${authResponse.data.errorMessage ?? 'No message'}`);
    }

    if (!authResponse.data.data?.token) {
      throw new Error('No token in auth response');
    }

    return authResponse.data.data;
  }

  private async createWebSession(authHash: string): Promise<Cookie> {
    const webSessionResponse = await axios.post<WebSessionResponse>(
      `${apiBaseUrl}/WebSession`,
      qs.stringify({
        temp_session: '1',
        session_type_id: '1',
      }),
      {
        headers: {
          ...this.apiHeaders(),
          Authorization: `Bearer ${authHash}`,
        },
        params: this.platformParams(),
      },
    );

    if (webSessionResponse.data.errorCode) {
      if (!this.configuredAuthHash) {
        await this.cache.delete('authHash');
      }
      throw new Error(`WebSession error (${webSessionResponse.data.errorCode}): ${webSessionResponse.data.errorMessage ?? 'No message'}`);
    }

    const tempSession = webSessionResponse.data.data?.temp_session;
    if (!tempSession) {
      throw new Error('No temp_session in Windscribe WebSession response');
    }

    const res = await axios.get<string>(`${webBaseUrl}/myaccount`, {
      headers: {
        'User-Agent': webUserAgent,
      },
      params: {
        temp_session: tempSession,
      },
      maxRedirects: 0,
      validateStatus: status => [200, 302].includes(status),
    });

    const setCookieHeaders = res.headers['set-cookie'];
    if (!setCookieHeaders) {
      throw new Error('No Set-Cookie header in temp_session response');
    }

    const wsSessionCookie = parseCookie(setCookieHeaders, {map: true, decodeValues: true})['ws_session_auth_hash'];
    if (!wsSessionCookie) {
      throw new Error('Failed to find ws_session_auth_hash in temp_session response');
    }

    return wsSessionCookie;
  }

  private apiHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
      'Accept': 'application/json, text/plain, */*',
    };
  }

  private platformParams(): Record<string, string> {
    return {
      platform,
      app_version: appVersion,
    };
  }

  private async clearCachedWindscribeSession(): Promise<void> {
    await this.cache.delete('sessionCookie');
  }

  private async getMyAccountCsrfToken(forceLogin: boolean = false): Promise<CsrfInfo> {
    try {
      const sessionCookie = await this.getSession(forceLogin);

      // get page
      const res = await axios.get<string>('https://windscribe.com/myaccount', {
        headers: {
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': webUserAgent,
        },
        maxRedirects: 0,
        validateStatus: status => [302, 200].includes(status),
      });

      if (res.status == 302) {
        await this.clearCachedWindscribeSession();
        return await this.getMyAccountCsrfToken(true);
      }

      // extract csrf tokena and time from page content
      const csrfTime = /csrf_time = (\d+);/.exec(res.data)[1];
      const csrfToken = /csrf_token = '(\w+)';/.exec(res.data)[1];

      return {
        csrfTime: +csrfTime,
        csrfToken: csrfToken,
      };
    } catch (error) {
      throw new Error(`Failed to get csrf token from my account page: ${error.message}`);
    }
  }

  private async getPortForwardingInfo(): Promise<PortForwardingInfo> {
    try {
      const sessionCookie = await this.getSession();

      // load sub page
      const res = await axios.get<string>('https://windscribe.com/staticips/load', {
        headers: {
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': webUserAgent,
        }
      });

      // extract data from page
      const epfExpires = res.data.match(/epfExpires = (\d+);/)[1]; // this is always present. set to 0 if no port is active
      // Extract ports from the new UI structure: <span class="pf-ext">10583</span> and <span class="pf-int">10011</span>
      const extPort = res.data.match(/<span class="pf-ext">(\d+)<\/span>/)?.[1];
      const intPort = res.data.match(/<span class="pf-int">(\d+)<\/span>/)?.[1];
      const ports = [extPort, intPort].filter((p): p is string => p !== undefined).map(p => +p);

      return {
        epfExpires: +epfExpires,
        ports,
      };
    } catch (error) {
      throw new Error(`Failed to get port forwarding info: ${error.message}`);
    }
  }

  private async removeEphemeralPort(csrfInfo: CsrfInfo): Promise<void> {
    try {
      const sessionCookie = await this.getSession();

      // remove port
      const res = await axios.post<{success: number, epf: boolean, message?: string}>('https://windscribe.com/staticips/deleteEphPort', qs.stringify({
        ctime: csrfInfo.csrfTime,
        ctoken: csrfInfo.csrfToken
      }), {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': webUserAgent,
        }
      });

      // check for errors
      if (res.data.success == 0) {
        throw new Error(`success = 0; ${res.data.message ?? 'No message'}`);
      }

      // make sure we actually removed it
      if (res.data.epf == false) {
        console.warn('Tried to remove a non-existent ephemeral port, ignoring');
      } else {
        console.log('Deleted ephemeral port');
      }
    } catch (error) {
      throw new Error(`Failed to delete ephemeral port: ${error.message}`);
    }
  }

  private getTorrentPort(portForwardingInfo: PortForwardingInfo): number {
    return portForwardingInfo.ports[1] ?? portForwardingInfo.ports[0];
  }

  private getAnnouncePort(portForwardingInfo: PortForwardingInfo): number {
    return this.ephemeralInternalPort ? portForwardingInfo.ports[0] : this.getTorrentPort(portForwardingInfo);
  }

  private async requestEphemeralPort(csrfInfo: CsrfInfo): Promise<PortForwardingInfo> {
    try {
      const sessionCookie = await this.getSession();
      const port = this.ephemeralInternalPort?.toString() ?? '';

      // request new port
      const res = await axios.post<{success: number, message?: string, epf?: {ext: number, int: number, start_ts: number}}>('https://windscribe.com/staticips/postEphPort', qs.stringify({
        ctime: csrfInfo.csrfTime,
        ctoken: csrfInfo.csrfToken,
        port, // empty string requests a matching port
      }), {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': webUserAgent,
        }
      });

      // check for errors
      if (res.data.success == 0) {
        throw new Error(`success = 0; ${res.data.message ?? 'No message'}`);
      }

      // epf should be present by this point
      const epf = res.data.epf!;
      if (this.ephemeralInternalPort) {
        console.log(`Created new specific ephemeral port: internal ${epf.int}, external ${epf.ext}`);
      } else {
        console.log(`Created new matching ephemeral port: ${epf.ext}`);
      }
      return {
        epfExpires: epf.start_ts,
        ports: [epf.ext, epf.int],
      };
    } catch (error) {
      const portRequestDescription = this.ephemeralInternalPort ? 'specific ephemeral port' : 'matching ephemeral port';
      throw new Error(`Failed to request ${portRequestDescription}: ${error instanceof Error ? error.message : error}`);
    }
  }

}
