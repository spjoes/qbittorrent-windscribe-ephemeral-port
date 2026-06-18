import {QBittorrent} from '@ctrl/qbittorrent';

interface QBittorrentPorts {
  listenPort: number,
  announcePort: number,
}

export class QBittorrentClient {

  private client: QBittorrent;
  private currentHost?: string;

  constructor(
    url: string,
    username?: string,
    password?: string,
    apiKey?: string,
  ) {
    this.client = new QBittorrent({
      baseUrl: url,
      ...(apiKey ? {apiKey} : {username, password}),
    });
  }

  async updateConnection(): Promise<{ hostId: string; version: string; }> {
    // login if not logged in already
    if (!await this.client.login()) {
      throw new Error('Failed to connect to client');
    }

    const apiversion = await this.client.getApiVersion();
    const version = await this.client.getAppVersion();

    // report status
    return {
      hostId: apiversion,
      version: version,
    };
  }

  async getPorts(): Promise<QBittorrentPorts> {
    // make sure we are connected
    await this.updateConnection();

    const {listen_port: listenPort, announce_port: announcePort = listenPort} = await this.client.getPreferences() as {
      listen_port: number,
      announce_port?: number,
    };

    return {
      listenPort,
      announcePort,
    };
  }

  async updatePort(port: number, announcePort: number = port): Promise<void> {
    // make sure we are connected
    await this.updateConnection();

    // update port
    const preferences = {
      listen_port: port,
      announce_port: announcePort,
      random_port: false, // turn of random port as well
    } as Parameters<QBittorrent['setPreferences']>[0] & {announce_port: number};

    await this.client.setPreferences(preferences);

    console.log(`Client port update requested. listen_port=${port}, announce_port=${announcePort}`);
  }

  async updateListenPort(port: number): Promise<void> {
    // make sure we are connected
    await this.updateConnection();

    await this.client.setPreferences({
      listen_port: port,
      random_port: false,
    });

    console.log(`Client listen port update requested. listen_port=${port}`);
  }

}
