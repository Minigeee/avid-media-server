// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { createServer as createHttpServer, IncomingMessage, Server as HttpServer } from 'http';

import express, { Express, Request, Response, NextFunction } from 'express';
import * as mediasoup from 'mediasoup';
import { WebRtcServerOptions, Worker } from 'mediasoup/node/lib/types';
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

import config from './config';
import { log } from './logs';
import { addParticipant, getRoom } from './rooms';

import { AclEntry, AllPermissions, Media_ClientToServerEvents, Media_ServerToClientEvents, Member } from '@app/types';
import { getJwtPublic } from './keys';
import { query, sql } from './query';


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
function getSessionUser(token?: string) {
    if (!token) return;

    try {
        const payload = jwt.verify(token, getJwtPublic());
        return payload as { profile_id: string; };
    }
    catch (error) {
        return;
    }
}


///////////////////////////////////////////////////////////
async function makeSocketServer() {
	// Create socket.io server
	_socketServer = new SocketServer(_httpServer, {
		cors: {
			origin: config.domains.cors,
			methods: ['GET', 'POST'],
			credentials: true,
		}
	});

	// Handle client connect
	_socketServer.on('connection', async (socket) => {
        // Parse headers to get identity
        const user = getSessionUser(socket.handshake.auth.token);
        if (!user?.profile_id) {
            log.warn('not authenticated');
            socket.emit('error', 'not authenticated', 401);
            socket.disconnect();
            return;
        }

        // Get ids
        const profile_id = user.profile_id;
        const room_id = socket.handshake.query.room_id as string;

        // Get user permissions
        const results = await query<[unknown, AclEntry[], Member]>(sql.multi([
            sql.let('$member', sql.wrap(sql.select<Member>(['roles', 'is_admin'], {
                from: `${room_id}.domain<-member_of`,
                where: sql.match({ in: profile_id }),
            }), { append: '[0]' })),
            sql.select<AclEntry>('*', {
                from: 'acl',
                where: sql.match<AclEntry>({
                    resource: room_id,
                    role: ['IN', sql.$('$member.roles')],
                }),
            }),
            'RETURN $member',
        ]), { complete: true });

        // Check if user can join
        let canJoin = results !== null;
        const permissions = new Set<AllPermissions>();
        if (results && canJoin) {
            // Create permissions set
            for (const entry of results[1]) {
                for (const p of entry.permissions)
                    permissions.add(p);
            }

            // Check for view permission
            canJoin = results[2].is_admin || permissions.has('can_view');
        }

        // Quit if can't join
        if (!canJoin) {
            log.warn('not authorized');
            socket.emit('error', 'not authorized', 403);
            socket.disconnect();
            return;
        }

        // Get room
        const room = await getRoom(room_id, _workers, _workerLoads);

        // Add participant to requested room
        await addParticipant(room, profile_id, socket, {
            is_admin: results?.[2].is_admin,
            permissions: permissions,
        });
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