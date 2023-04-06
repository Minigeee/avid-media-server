// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { createServer as createHttpServer, IncomingMessage, Server as HttpServer } from 'http';

import express, { Express, Request, Response, NextFunction } from 'express';
import * as mediasoup from 'mediasoup';
import { WebRtcServerOptions, Worker } from 'mediasoup/node/lib/types';
import { Server as SocketServer, Socket } from 'socket.io';

import config from './config';
import { redis } from './db';
import { addParticipant, getRoom } from './rooms';
import { Media_ClientToServerEvents, Media_ServerToClientEvents, SessionUser } from 'avid-types';


const _workers: Worker[] = [];
const _workerLoads: number[] = [];

let _httpServer: HttpServer;
let _expressApp: Express;
let _socketServer: SocketServer<Media_ClientToServerEvents, Media_ServerToClientEvents>;


///////////////////////////////////////////////////////////
async function makeMediasoupWorkers() {
    const { numWorkers } = config.mediasoup;
    
	console.log('running %d mediasoup Workers...', numWorkers);

    // Create specified number of workers
    for (let i = 0; i < numWorkers; ++i) {
        // Create worker and add to list
        const worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.workerSettings.logLevel,
            logTags: config.mediasoup.workerSettings.logTags,
            rtcMinPort: Number(config.mediasoup.workerSettings.rtcMinPort),
            rtcMaxPort: Number(config.mediasoup.workerSettings.rtcMaxPort)
        });
        _workers.push(worker);
        _workerLoads.push(0.0);

        worker.on('died', () => {
            console.log('mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);

            setTimeout(() => process.exit(1), 2000);
        });

        // Create webrtc server
        const webRtcServerOptions = JSON.parse(JSON.stringify(config.mediasoup.webRtcServerOptions)) as WebRtcServerOptions;
        const portIncrement = _workers.length - 1;

        for (const listenInfo of webRtcServerOptions.listenInfos) {
            if (listenInfo.port !== undefined)
                listenInfo.port += portIncrement;
        }

        const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);

        // Add custom data
        worker.appData.webRtcServer = webRtcServer;
        worker.appData._prevUsageTime = 0;

        setInterval(async () => {
            // Calculate cpu load
			const usage = await worker.getResourceUsage();
            const total = usage.ru_stime + usage.ru_utime;
            const load = (total - (worker.appData._prevUsageTime as number)) / config.mediasoup.loadUpdateInterval;

            // Store data
            worker.appData._prevUsageTime = total;
            worker.appData.cpuLoad = load;

            // Save load
            _workerLoads[i] = load;

            // console.log(`${worker.pid} load: ${load * 100}%`);
		}, config.mediasoup.loadUpdateInterval);
    }

    // Write cpu usages to database
    setInterval(async () => {
    }, config.mediasoup.loadUpdateInterval);
}


///////////////////////////////////////////////////////////
async function makeExpressServer() {
    _expressApp = express();
    _httpServer = createHttpServer(_expressApp);

    // Launch express app
    const port = process.env.PORT || 3002;
    _httpServer.listen(port, () => console.log(`Media server running on port ${port}`));
}


///////////////////////////////////////////////////////////
async function getSessionUser(cookie?: string): Promise<SessionUser | undefined> {
    if (!cookie) return;

    // Create cookie map
    const cookies: Record<string, string> = {};
    for (const entry of cookie.split(';')) {
        const [key, value] = entry.trim().split('=');
        cookies[key] = value;
    }

    // Find sid
    let sid = cookies[config.sid_field];
    if (!sid) return;

    // Parse session string
    sid = decodeURIComponent(sid).split(':')[1].split('.')[0];

    // Get session
    const session = await redis.json.get('s' + sid).then((result: any) => {
        return {
            ...result,
            cookie: {
                ...result.cookie,
                _expires: new Date(result.cookie._expires),
            },
        };
    });

    // Return user
    return session.passport.user;
}

///////////////////////////////////////////////////////////
async function makeSocketServer() {
	// Create socket.io server
	_socketServer = new SocketServer(_httpServer, {
		cors: {
			origin: config.domains.site,
			methods: ['GET', 'POST'],
			credentials: true,
		}
	});

	// Handle client connect
	_socketServer.on('connection', async (socket) => {
        // Parse headers to get identity
        const user = await getSessionUser(socket.handshake.headers.cookie);
        if (!user || !user.data.profile?._id) {
            // TODO : Error logging
            console.log('Not authenticated');
            return;
        }

        // Get ids
        const profile_id = user.data.profile._id;
        const room_id = socket.handshake.query.room_id as string;

        // TODO : Check if user has permissions

        // Get room
        const room = await getRoom(room_id, _workers, _workerLoads);

        // Add participant to requested room
        await addParticipant(room, profile_id, socket);
	});
}

///////////////////////////////////////////////////////////
export function io() { return _socketServer; }


///////////////////////////////////////////////////////////
async function main() {
    // Create mediasoup workers
    await makeMediasoupWorkers();

    // Create express (and http) server
    await makeExpressServer();

    // Create socket.io server
    await makeSocketServer();
}


main();