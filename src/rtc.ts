import {
	AudioLevelObserverOptions,
	Consumer,
	Producer,
	ProducerOptions,
	Router,
	WebRtcServer,
	WebRtcTransport,
	WebRtcTransportOptions,
} from 'mediasoup/node/lib/types';

import config from './config';
import { Participant, Room } from './rooms';

type RtcTransportType = 'producer' | 'consumer';


/**
 * Creates and returns a webrtc transport
 * 
 * @param room The room to make a tranport for
 * @param participant_id The participant to make a transport for
 * @param type The type of tranport to create
 * @param forceTcp Indicates if tcp should be forced
 * @returns The tranposrt object
 */
export async function makeWebRtcTransport(room: Room, participant_id: string, type: RtcTransportType, forceTcp: boolean = false) {
	// Create options
	const options: WebRtcTransportOptions = {
		...config.mediasoup.webRtcTransportOptions,
		appData: { type }
	};
	
	if (forceTcp) {
		options.enableUdp = false;
		options.enableTcp = true;
	}

	// Create transport
	const transport = await room.router.createWebRtcTransport({
		...options,
		listenIps: undefined,
		port: undefined,
		webRtcServer: room.worker.appData.webRtcServer as WebRtcServer,
	});
	
	// TODO : Logging
	transport.on('sctpstatechange', (sctpState) => {
		console.log('WebRtcTransport "sctpstatechange" event [sctpState:%s]', sctpState);
		/* logger.debug('WebRtcTransport "sctpstatechange" event [sctpState:%s]', sctpState); */
	});

	transport.on('dtlsstatechange', (dtlsState) => {
		if (dtlsState === 'failed' || dtlsState === 'closed')
			console.log('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState);
		/* if (dtlsState === 'failed' || dtlsState === 'closed')
			logger.warn('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState); */
	});

	// Store transport
	room.participants[participant_id].transports[transport.id] = transport;
	
	// If set, apply max incoming bitrate limit
	const { maxIncomingBitrate } = config.mediasoup.webRtcTransportOptions;
	if (maxIncomingBitrate) {
		try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); }
		catch (error) { }
	}

	return transport;
}


/**
 * Create a new producer for the specified transport and attach all event handlers
 * 
 * @param transport The transport to create a producer for
 * @param options The producer options
 * @returns A new producer object
 */
export async function makeProducer(participant: Participant, transport: WebRtcTransport, options: ProducerOptions) {
	const producer = await transport.produce(options);

	// Attach producer listeners
	producer.on('score', (score) => {
		// Send producer score
		participant.socket.emit('producer-score', producer.id, score);
	});

	producer.on('videoorientationchange', (videoOrientation) => {
		/* TODO : logger.debug(
			'producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
			producer.id, videoOrientation); */
	});

	// NOTE: For testing.
	// await producer.enableTraceEvent([ 'rtp', 'keyframe' ]);
	// await producer.enableTraceEvent([ 'pli', 'fir' ]);
	// await producer.enableTraceEvent([ 'keyframe' ]);

	producer.on('trace', (trace) => {
		console.log('prod trace', trace)
	});

	// Add producer to participant
	participant.producers[producer.id] = producer;

	return producer;
}


/**
 * Create a new mediasoup consumer
 * 
 * @param options.room The room to create the new consumer in
 * @param options.transport The transport to create the new consumer in
 * @param options.participant.consumer The participant that will be consuming media
 * @param options.participant.producer The participant that will be producing media
 * @param options.producer The producer object to create a consumer for
 * @returns A new consumer object
 */
export async function makeConsumer(options: {
	room: Room;
	transport: WebRtcTransport;
	participant: {
		consumer: Participant;
		producer: Participant;
	};
	producer: Producer;
}) {
	const {
		room,
		transport,
		participant,
		producer
	} = options;

	// Get router
	const router = room.router;

	// Check if the consumer can consume media from producer
	if (!participant.consumer.capabilities.rtp || !router.canConsume({
		producerId: producer.id,
		rtpCapabilities: participant.consumer.capabilities.rtp,
	}))
		return;

	// Create the consumer in paused mode
	let consumer: Consumer;
	try {
		consumer = await transport.consume({
			producerId: producer.id,
			rtpCapabilities: participant.consumer.capabilities.rtp,
			paused: true,
		});
	}
	catch (error) {
		// TODO : Log Error
		console.log('failed to create consumer');
		return;
	}

	// Add consumer to participant
	participant.consumer.consumers[consumer.id] = consumer;


	// Add consumer event handlers
	consumer.on('transportclose', () => {
		// Remove from its map
		delete participant.consumer.consumers[consumer.id];
	});

	consumer.on('producerclose', () => {
		// Remove from its map
		delete participant.consumer.consumers[consumer.id];

		// Notify of consumer closing
		participant.consumer.socket.emit('consumer-closed', consumer.id);
	});

	consumer.on('producerpause', () => {
		// Notify of consumer pausing
		participant.consumer.socket.emit('consumer-paused', consumer.id);
	});

	consumer.on('producerresume', () => {
		// Notify of consumer resuming
		participant.consumer.socket.emit('consumer-resumed', consumer.id);
	});

	consumer.on('score', (score) => {
		// Notify of consumer score
		participant.consumer.socket.emit('consumer-score', consumer.id, score);
	});

	consumer.on('layerschange', (layers) => {
		// Notify num layers
		participant.consumer.socket.emit(
			'consumer-layers-changed',
			consumer.id,
			layers?.spatialLayer || null,
			layers?.temporalLayer || null
		);
	});

	// NOTE: For testing.
	// await consumer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
	// await consumer.enableTraceEvent([ 'pli', 'fir' ]);
	// await consumer.enableTraceEvent([ 'keyframe' ]);

	consumer.on('trace', (trace) => {
		console.log('consumer trace', trace.type);
	});

	// Notify client to make client-side consumer
	participant.consumer.socket.emit('make-consumer', {
		peerId: participant.producer.id,
		producerId: producer.id,
		id: consumer.id,
		kind: consumer.kind,
		rtpParameters: consumer.rtpParameters,
		type: consumer.type,
		appData: producer.appData,
		producerPaused: consumer.producerPaused
	}, async (success) => {
		try {
			if (!success)
				throw new Error('failed to create client-side consumer');

			// Now that we got the positive response from the remote endpoint, resume
			// the Consumer so the remote endpoint will receive the a first RTP packet
			// of this new stream once its PeerConnection is already ready to process
			// and associate it.
			await consumer.resume();

			// Notify initial score
			participant.consumer.socket.emit('consumer-score', consumer.id, consumer.score);
		}
		catch (err) {
			// TODO : Logging
			console.log(err);
		}
	});
}


export async function makeAudioLevelObserver(router: Router, options: AudioLevelObserverOptions) {
	// Create observer
	const observer = await router.createAudioLevelObserver(options);

	// Attach event listeners
	observer.on('volumes', (volumes) => {
		const { producer, volume } = volumes[0];

		console.log(`volume ${volume}`)

		// Notify all Peers.
		/* TODO : for (const peer of this._getJoinedPeers()) {
			peer.notify(
				'activeSpeaker',
				{
					peerId: producer.appData.peerId,
					volume: volume
				})
				.catch(() => { });
		} */
	});

	observer.on('silence', () => {
		console.log('silence');

		// Notify all Peers.
		/* TODO : for (const peer of this._getJoinedPeers()) {
			peer.notify('activeSpeaker', { peerId: null })
				.catch(() => { });
		} */
	});

	return observer;
}