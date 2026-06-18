import 'dotenv/config';
import path from 'path';
import {KeyvFile} from 'keyv-file';
import {getConfig} from './config.js';
import {QBittorrentClient} from './QBittorrentClient.js';
import {WindscribeClient, WindscribePort} from './WindscribeClient.js';
import {schedule} from 'node-cron';
import * as fs from 'fs';
import Docker from 'dockerode';
import {setTimeout as sleep} from 'timers/promises';

// load config
const config = getConfig();

// Docker client setup
const docker = config.gluetunContainerName || config.qbittorrentContainerName ? new Docker({socketPath: '/var/run/docker.sock'}) : null;

// init cache (if configured)
const cache = !config.cacheDir ? undefined : new KeyvFile({
  filename: path.join(config.cacheDir, 'cache.json'),
});

// init windscribe client
const windscribe = new WindscribeClient(
  config.windscribeUsername,
  config.windscribePassword,
  config.windscribeAuthHash,
  cache,
  config.windscribeTotpSecret,
  config.windscribeEphemeralInternalPort,
);

// init torrent client
const client = new QBittorrentClient(config.clientUrl, config.clientUsername, config.clientPassword, config.clientApiKey);

// init schedule if configured
const scheduledTask = !config.cronSchedule
  ? null
  : schedule(config.cronSchedule, () => run('schedule'));

async function update() {
  let nextRetry: Date = null;
  let nextRun: Date = null;

  let portInfo: WindscribePort;
  try {
    // try to update ephemeral port
    portInfo = await windscribe.updatePort();

    const windscribeExtraDelay = config.windscribeExtraDelay || (60 * 1000);
    nextRun = new Date(portInfo.expires.getTime() + windscribeExtraDelay);
  } catch (error) {
    console.error('Windscribe update failed: ', error);

    // if failed, retry after some delay
    const windscribeRetryDelay = config.windscribeRetryDelay || (60 * 60 * 1000);
    nextRetry = new Date(Date.now() + windscribeRetryDelay);

    // get cached info if available
    portInfo = await windscribe.getPort();
  }

  try {
    let currentPorts = await client.getPorts();
    if (portInfo) {
      if (currentPorts.listenPort == portInfo.port && currentPorts.announcePort == portInfo.announcePort) {
        // no need to update
        console.log(`Current torrent ports already match windscribe ports. listen_port=${currentPorts.listenPort}, announce_port=${currentPorts.announcePort}`);
      } else {
        // update ports to new ones
        console.log(`Current torrent ports (listen_port=${currentPorts.listenPort}, announce_port=${currentPorts.announcePort}) do not match windscribe ports (listen_port=${portInfo.port}, announce_port=${portInfo.announcePort})`);
        await client.updatePort(portInfo.port, portInfo.announcePort);

        // double check
        currentPorts = await client.getPorts();
        if (currentPorts.listenPort != portInfo.port) {
          throw new Error(`Unable to set torrent listen port! Current torrent listen port: ${currentPorts.listenPort}`);
        }
        if (currentPorts.announcePort != portInfo.announcePort) {
          throw new Error(`Unable to set torrent announce port! Current torrent announce port: ${currentPorts.announcePort}`);
        }
        // write the new port to configured gluetunCfgDir.
        writeExportedPort(config.gluetunIface, currentPorts.listenPort);

        await restartConfiguredContainers(portInfo);

        console.log('Torrent port updated');
      }
    } else {
      console.log(`Windscribe port is unknown, current torrent ports are listen_port=${currentPorts.listenPort}, announce_port=${currentPorts.announcePort}`);
    }
  } catch (error) {
    console.error('Torrent update failed', error);

    // if failed, retry after some delay
    const clientRetryDelay = config.clientRetryDelay || (5 * 60 * 1000);
    nextRetry = new Date(Date.now() + clientRetryDelay);
  }

  return {
    nextRun,
    nextRetry,
  };
}

let timeoutId: NodeJS.Timeout; // next run/retry timer
async function run(trigger: string) {
  console.log(`Starting update, trigger type: ${trigger}`);

  // clear any previous timeouts (relevant when triggered by schedule)
  clearTimeout(timeoutId);

  // the magic
  const {nextRun, nextRetry} = await update().catch(error => {
    // in theory this should never throw, if it does we have bigger problems
    console.error(error);
    process.exit(1);
  });

  // reties always take priority since they block normal runs from the retry delay
  if (nextRetry) {
    // disable schedule if present
    scheduledTask?.stop();

    // calculate delay
    const delay = nextRetry.getTime() - Date.now();
    console.log(`Next retry scheduled for ${nextRetry.toLocaleString()} (in ${Math.floor(delay / 100) / 10} seconds)`);

    // set timer
    timeoutId = setTimeout(() => run('retry'), delay);
  } else if (nextRun) {
    // re-enable schedule if present
    scheduledTask?.start();

    // calculate delay
    const delay = nextRun.getTime() - Date.now();
    console.log(`Next normal run scheduled for ${nextRun.toLocaleString()} (in ${Math.floor(delay / 100) / 10} seconds)`);
    if (scheduledTask != null) {
      console.log('Cron schedule is configured, there might be runs happening sooner!');
    }

    // set timer
    timeoutId = setTimeout(() => run('normal'), delay);
  } else {
    // in theory this should never happen
    console.error('Invalid state, no next retry/run date present');
    process.exit(1);
  }
}

/**
 * Convert a port number to iptable entries and write to file defined in config.gluetunCfgDir
 * @param {string} iface   Interface name. Eg: tun0
 * @param {number} port    Port forwarded port number
 */
function writeExportedPort(iface: string, port: number) {
  const iptablesStr = `iptables -A INPUT -i ${iface} -p tcp --dport ${port} -j ACCEPT
iptables -A INPUT -i ${iface} -p udp --dport ${port} -j ACCEPT`;
  fs.writeFileSync(config.gluetunCfgDir, iptablesStr, {
    flag: 'w',
  });
  console.log('New port %d exported to file: %s with iface: %s', port, config.gluetunCfgDir, iface);
}

async function restartConfiguredContainers(portInfo: WindscribePort): Promise<void> {
  if (!docker) {
    return;
  }

  if (config.gluetunContainerName) {
    await restartContainer(config.gluetunContainerName, 'Gluetun');
  }

  if (config.qbittorrentContainerName) {
    await restartContainer(config.qbittorrentContainerName, 'qBittorrent');
    await reapplyQbittorrentListenPortAfterRestart(portInfo);
  }
}

async function restartContainer(containerName: string, label: string): Promise<void> {
  console.log(`Restarting ${label} container: ${containerName}`);
  await docker.getContainer(containerName).restart();
  console.log(`Restarted ${label} container: ${containerName}`);
}

async function reapplyQbittorrentListenPortAfterRestart(portInfo: WindscribePort): Promise<void> {
  const attempts = 12;
  const delay = 5000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await client.updateListenPort(portInfo.port);
      const currentPorts = await client.getPorts();

      if (currentPorts.listenPort != portInfo.port) {
        throw new Error(`Current ports are listen_port=${currentPorts.listenPort}, announce_port=${currentPorts.announcePort}`);
      }

      console.log(`Re-applied qBittorrent listen port after restart. listen_port=${currentPorts.listenPort}, announce_port=${currentPorts.announcePort}`);
      return;
    } catch (error) {
      if (attempt == attempts) {
        throw new Error(`Failed to re-apply qBittorrent listen port after restart: ${error instanceof Error ? error.message : error}`);
      }

      console.log(`qBittorrent is not ready after restart, retrying listen port re-apply in ${delay / 1000} seconds (${attempt}/${attempts})`);
      await sleep(delay);
    }
  }
}

// always run on start
run('initial');
