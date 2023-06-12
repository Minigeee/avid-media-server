import { Consumer } from 'mediasoup/node/lib/Consumer';
import {
	AudioLevelObserver,
	DtlsParameters,
	MediaKind,
	Producer,
	Router,
	RtpCapabilities,
	RtpParameters,
	SctpCapabilities,
	WebRtcTransport,
	Worker
} from 'mediasoup/node/lib/types';

import config from './config';
import { Logger } from './logs';
import { makeAudioLevelObserver, makeConsumer, makeProducer, makeWebRtcTransport } from './rtc';
import { io } from './server';
import { Socket } from './types';
import { query, sql } from './query';
import wrapper from './wrapper';

import { AllPermissions, Channel } from '@app/types';
import assert from 'assert';

/** Type representing an rtc participant */
export type Participant = {
	/** Participant id */
	id: string;
	/** Indicates if participant is joined and ready */
	joined: boolean;
	/** Socket used for communication */
	socket: Socket;
	/** The client-side mediasoup device */
	device: any;
	/** A map of webrtc transports */
	transports: Record<string, WebRtcTransport>;
	/** A map of producers associated with particpant */
	producers: Record<string, Producer>;
	/** A map of consumers associated with particpant */
	consumers: Record<string, Consumer>;
	/** Webrtc capabilities */
	capabilities: {
		/** Rtp capabilities */
		rtp?: RtpCapabilities;
		/** Sctp capabilities */
		sctp?: SctpCapabilities;
	};
	
	/** Indicates if participant is a domain admin */
	is_admin: boolean | undefined;
	/** Participant's permissions */
	permissions: Set<AllPermissions>;
};

/** Type representing an rtc room */
export type Room = {
	/** The id of the room (the channel id) */
	id: string;
	/** The mediasoup worker this room belongs to */
	worker: Worker;
	/** The mediasoup router used to represent this room */
	router: Router;
	/** Room logger */
	log: Logger;

	/** RTC event observers */
	observers: {
		/** Observes audio levels from audio producers */
		audio_level?: AudioLevelObserver;
	};
	/** A list of participants in the room */
	participants: Record<string, Participant>;
	/** A set of participant ids that are speaking */
	speaking: Set<string>,
};

/** Type representing all rtc options a participant can use */
type ParticpantOptions = {
	/** Indicates if participant is a domain admin */
	is_admin: boolean | undefined;
	/** Participant's permissions */
	permissions: Set<AllPermissions>;
	/** Indicates if tcp should be forced */
	forceTcp?: boolean;
	/** Indicates if user will be a producer */
	producer?: boolean;
	/** Indicates if user will be a consumer */
	consumer?: boolean;
};


/** All rooms in server */
const _rooms: Record<string, Room> = {};


/**
 * Get or create a new room
 * 
 * @param room_id Id of the room to retrieve
 * @param workers A list of workers to chose from
 * @param loads A cpu load value for each worker
 * @returns A room object
 */
export async function getRoom(room_id: string, workers: Worker[], loads: number[]) {
	let room: Room = _rooms[room_id];

	// Check if room exists
	if (!room) {
		// Router media codecs
		const { mediaCodecs } = config.mediasoup.routerOptions;

        // Get worker with lowest load
        let workerIdx = 0;
        for (let i = 0; i < loads.length; ++i) {
            if (loads[i] < loads[workerIdx])
                workerIdx = i;
        }
		const worker = workers[workerIdx];

		// Make router
		const router = await worker.createRouter({ mediaCodecs });

		// Create room
		room = {
			id: room_id,
			worker,
			router,
			log: new Logger({}),
			observers: {},
			participants: {},
			speaking: new Set<string>(),
		};

		// Create room properties that depend on other properties
		room.log = new Logger({ room });

		// Make observers
		const audioLevelObserver = await makeAudioLevelObserver(room, {
			maxEntries: 5,
			threshold: -80,
			interval: 500
		});

		room.observers.audio_level = audioLevelObserver;

		// Save room to map
		_rooms[room_id] = room;

		// Logging
		room.log.info(`created new room`);
	}

	return room;
}


/**
 * Close a room
 * 
 * @param room_id The id of the room to close
 */
export async function closeRoom(room_id: string) {
	// Get room
	const room = _rooms[room_id];

	// Force remaining participants to disconnect
	for (const participant of Object.values(room.participants))
		participant.socket.disconnect();

	// Close router
	room.router.close();

	// Logging
	room.log.info(`closed room`);

	// Remove room from map
	delete _rooms[room_id];
}


/**
 * Add a participant to a room and execute initialization code
 * required for a participant to join room.
 * 
 * @param room The room object to add the participant to
 * @param participant_id The id of the participant to add
 * @param socket The socket associated with the participant
 * @param options Options for the participant
 */
export async function addParticipant(room: Room, participant_id: string, socket: Socket, options: ParticpantOptions) {
	// Check if participant already added
	if (room.participants[participant_id]) return;

	// Create new entry for participant
	room.participants[participant_id] = {
		id: participant_id,
		joined: false,
		socket: socket,
		device: undefined,
		transports: {},
		producers: {},
		consumers: {},
		capabilities: {},

		is_admin: options.is_admin,
		permissions: options.permissions,
	};

	// Add room to socket.io room
	socket.join(room.id);

	// Create producer transport (if a producer and has permission to do either audio or video)
	let producerConfig;
	if (options?.producer === false ? false : (options.is_admin || options.permissions.has('can_speak') || options.permissions.has('can_share_video'))) {
		const transport = await makeWebRtcTransport(room, participant_id, 'producer', options?.forceTcp);

		producerConfig = {
			id: transport.id,
			iceParameters: transport.iceParameters,
			iceCandidates: transport.iceCandidates,
			dtlsParameters: transport.dtlsParameters,
			sctpParameters: transport.sctpParameters
		};
	}

	// Create consumer transport
	let consumerConfig;
	if (options?.consumer === false ? false : true) {
		const transport = await makeWebRtcTransport(room, participant_id, 'consumer', options?.forceTcp);
		
		consumerConfig = {
			id: transport.id,
			iceParameters: transport.iceParameters,
			iceCandidates: transport.iceCandidates,
			dtlsParameters: transport.dtlsParameters,
			sctpParameters: transport.sctpParameters
		};
	}

	// Called when the socket disconnects for any reason
	socket.on('disconnect', wrapper.event(room, participant_id, (reason) => {
		const participant = room.participants[participant_id];

		// Notify all other peers
		if (participant.joined)
			socket.to(room.id).emit('participant-left', participant_id);

		// Iterate and close all transports (and any producers and consumers attached to them)
		for (const transport of Object.values(participant.transports))
			transport.close();

		// Remove participant from list in db
		query(sql.update<Channel<'rtc'>>(room.id, {
			set: { "data.participants": ['-=', participant_id] }
		}));

		// Remove participant from list
		delete room.participants[participant_id];

		// Logging
		room.log.info(`participant left`, { data: { participant_id } });

		// If this is the latest Peer in the room, close the room.
		if (Object.values(room.participants).length === 0) {
			room.log.info('last participent left, closing room');

			closeRoom(room.id);
		}
	}));

	// Called when client creates client-side device and transports. The capabilities
	// are saved so server can connect producer -> consumer correctly and deny any invalid
	// connections, based on each client's capabilities. By the end of this function, the client
	// is fully joined, and a consumer is created for each producer within the room.
	socket.on('config', wrapper.event(room, participant_id, (device, rtpCapabilities: RtpCapabilities, sctpCapabilities: SctpCapabilities) => {
		const participant = room.participants[participant_id];

		// Save client config
		participant.device = device;
		participant.capabilities.rtp = rtpCapabilities;
		participant.capabilities.sctp = sctpCapabilities;

		// Mark client as joined and ready
		participant.joined = true;

		// Acknowledge that client is joined, while sending a list of already joined participants
		const joined = getJoinedParticipants(room, participant_id);
		socket.emit('joined', joined.map(x => x.id), () => {
			// Create consumers for newly joined client for all other producer clients
			const transport = Object.values(participant.transports).find(t => t.appData.type === 'consumer');
			assert(transport, 'could not find a consumer transport');
	
			// Iterate all joined participants
			for (const peer of joined) {
				// Create consumer for each producer
				for (const producer of Object.values(peer.producers)) {
					makeConsumer({
						room,
						participant: {
							consumer: participant,
							producer: peer,
						},
						producer,
						transport,
					});
				}
	
				// TODO : Add data consumers
			}
		});

		// Logging
		room.log.info(`participant successfully joined`, { data: { participant_id } });

		// Notify all other clients of the newly joined client
		socket.to(room.id).emit('participant-joined', participant_id);

		// Add to list of participants in db
		query(sql.update<Channel<'rtc'>>(room.id, {
			set: { "data.participants": ['+=', participant_id] }
		}));
	}));

	// Called whenever a transport is used for the first time. It connects the server-side
	// transport to the client-side tranport so data can start flowing.
	socket.on('connect-transport', wrapper.event(room, participant_id, async (transport_id: string, dtlsParameters: DtlsParameters) => {
		const participant = room.participants[participant_id];
		const transport = participant.transports[transport_id];
		assert(transport, 'transport does not exist');

		await transport.connect({ dtlsParameters: dtlsParameters });

		// Logging
		room.log.verbose('new transport connected', { data: { participant_id, transport_id: transport.id } });
	}));

	// Called when client starts producing. It creates the server-side producer and returns
	// the producer id so that the client can complete creating the client-side producer
	socket.on('produce', wrapper.event(room, participant_id, async (
		transport_id: string,
		{ kind, rtpParameters, appData },
		callback: (producer_id: string | null) => void
	) => {
		const participant = room.participants[participant_id];
		assert(participant?.joined, 'participant does not exist or is not joined');

		// Deny producer creation if do not have permission
		if (!participant.is_admin) {
			if ((kind === 'audio' && !participant.permissions.has('can_speak')) || (kind === 'video' && !participant.permissions.has('can_share_video'))) {
				callback(null);
				return;
			}
		}

		// Get transport
		const transport = participant.transports[transport_id];
		assert(transport, 'transport does not exist');

		// Add participant id to app data
		appData = { ...appData, participant_id };

		// Create producer
		const producer = await makeProducer(room, participant, transport, {
			kind: kind as MediaKind,
			rtpParameters: rtpParameters as RtpParameters,
			appData,
			// keyFrameRequestDelay: 5000
		});

		// Return producer id
		callback(producer.id);

		// Create a consumer for each joined peer
		for (const peer of getJoinedParticipants(room, participant_id)) {
		// for (const peer of getJoinedParticipants(room)) {
			// Find consumer peer's consumer transport
			const consumerTransport = Object.values(peer.transports).find(t => t.appData.type === 'consumer');
			if (!consumerTransport) continue;

			// Make consumer
			makeConsumer({
				room,
				participant: {
					consumer: peer,
					producer: participant,
				},
				producer,
				transport: consumerTransport,
			});
		}

		// TODO : Add producer to observers
		if (room.observers.audio_level && producer.kind === 'audio') {
			room.observers.audio_level.addProducer({ producerId: producer.id }).catch(console.log);
		}

		// Logging
		room.log.verbose('new producer created', { data: { participant_id, transport_id, producer_id: producer.id } });
	}));


	// Consumer Events

	// Called when a consumer pauses on client-side
	socket.on('consumers-paused', wrapper.event(room, participant_id, async (consumer_ids: string[]) => {
		const participant = room.participants[participant_id];
		assert(participant?.joined, 'participant does not exist or is not joined');

		// Loop and pause all consumers
		for (const id of consumer_ids) {
			// Get consumer
			const consumer = participant.consumers[id];
			assert(consumer, `consumer with id "${id}" does not exist`);
	
			// Pause consumer
			consumer.pause();
		}

		// Logging
		room.log.verbose('participant deafened', { data: { participant_id } });
	}));

	// Called when a consumer pauses on client-side
	socket.on('consumers-resumed', wrapper.event(room, participant_id, async (consumer_ids: string[]) => {
		const participant = room.participants[participant_id];
		assert(participant?.joined, 'participant does not exist or is not joined');

		// Loop and resume all consumers
		for (const id of consumer_ids) {
			// Get consumer
			const consumer = participant.consumers[id];
			assert(consumer, `consumer with id "${id}" does not exist`);
	
			// Resume consumer
			consumer.resume();
		}
		
		// Logging
		room.log.verbose('participant undeafened', { data: { participant_id } });
	}));


	// Producer Events

	// Called when a producer closes on client-side
	socket.on('producer-closed', wrapper.event(room, participant_id, (producer_id: string) => {
		const participant = room.participants[participant_id];
		assert(participant?.joined, 'participant does not exist or is not joined');

		// Get producer
		const producer = participant.producers[producer_id];
		assert(producer, `producer with id "${producer_id}" does not exist`);

		// Close producer
		producer.close();

		// Remove from producer maps
		delete participant.producers[producer_id];

		// Logging
		room.log.verbose('producer closed', { data: { participant_id, producer_id } });
	}));

	// Called when a producer pauses on client-side
	socket.on('producer-paused', wrapper.event(room, participant_id, async (producer_id: string) => {
		const participant = room.participants[participant_id];
		assert(participant?.joined, 'participant does not exist or is not joined');

		// Get producer
		const producer = participant.producers[producer_id];
		assert(producer, `producer with id "${producer_id}" does not exist`);

		// Pause producer
		await producer.pause();

		// Logging
		room.log.verbose('producer paused/muted', { data: { participant_id, producer_id } });
	}));

	// Called when a producer resumes on client-side
	socket.on('producer-resumed', wrapper.event(room, participant_id, async (producer_id: string) => {
		const participant = room.participants[participant_id];
		assert(participant?.joined, 'participant does not exist or is not joined');

		// Get producer
		const producer = participant.producers[producer_id];
		assert(producer, `producer with id "${producer_id}" does not exist`);

		// Resume producer
		await producer.resume();

		// Logging
		room.log.verbose('producer resumed/unmuted', { data: { participant_id, producer_id } });
	}));


	// Emit configuration data (the router's rtp capabilities and the parameters for creating
	// client-side send and receive transports). The client's job is to create the client-side
	// rtc device and to create client-side transports. They should then send back their own device
	// configuration and rtp/sctp capabilities.
	socket.emit('config', room.router.rtpCapabilities, producerConfig, consumerConfig);
	
	// Logging
	room.log.info(`new participant joining`, { data: { participant_id } });
}


/**
 * Get a list of joined particpants within a room. This only
 * returns particpants that are fully joined, not requesting to join.
 * 
 * @param room The room to retrieve participants from
 * @param exclude_id The id of a participant to exclude from the list
 * @returns A list of participants that are joined
 */
function getJoinedParticipants(room: Room, exclude_id?: string) {
	return Object.values(room.participants).filter((user) => user.joined && user.id !== exclude_id);
}