import os from 'os';

import {
    RtpCodecCapability,
    WebRtcServerOptions,
    WorkerSettings,
} from 'mediasoup/node/lib/types';

const dev_mode = process.env.NODE_ENV === 'development';


const config = {
    dev_mode,

    sid_field: 'connect.sid',
    domains: dev_mode ? {
        api: 'http://localhost:3001',
        site: 'http://localhost:3000',
    } : {
        api: '',
        site: '',
    },
    
	/** Logger configuration */
	logger: {
		/** Mode the logger should operate under */
		mode: dev_mode ? 'local' : 'remote',
		/** Indicates if log files are enabled */
		log_file: !dev_mode,
		/** The log levels at or above which log entry ids should be assigned */
		id_level: 2, // "info"
		/** The log levels at or above which should be saved to remote database */
		remote_level: 0, // "error"

		/** Discord webhook used for error notifications */
		discord_webhook: process.env.DISCORD_WEBHOOK,
		/** Discord role id that should be pinged on new error */
		discord_role_id: '',
	},

	/** Database configurations */
	db: {
		/** Mongo configurations */
		mongo: {
			/** Connection url */
			url: process.env.MONGODB_CONNECTION_URL,
		},
		/** Redis configurations */
		redis: {
			/** Connection url */
			url: process.env.REDIS_CONNECTION_URL,
		},
	},

    mediasoup:
    {
        // Number of mediasoup workers to launch.
        // numWorkers: Object.keys(os.cpus()).length,
        numWorkers: 2,

        // cpu load update interval
        loadUpdateInterval: 60 * 1000,

        // mediasoup WorkerSettings.
        // See https://mediasoup.org/documentation/v3/mediasoup/api/#WorkerSettings
        workerSettings: {
            logLevel: 'debug',
            logTags:
                [
                    'info',
                    'ice',
                    'dtls',
                    'rtp',
                    'srtp',
                    'rtcp',
                    'rtx',
                    'bwe',
                    'score',
                    'simulcast',
                    'svc',
                    'sctp'
                ],
            rtcMinPort: process.env.MEDIASOUP_MIN_PORT || 40000,
            rtcMaxPort: process.env.MEDIASOUP_MAX_PORT || 49999
        } as WorkerSettings,

        // mediasoup Router options.
        // See https://mediasoup.org/documentation/v3/mediasoup/api/#RouterOptions
        routerOptions: {
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters: {
                        'x-google-start-bitrate': 1000
                    }
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP9',
                    clockRate: 90000,
                    parameters: {
                        'profile-id': 2,
                        'x-google-start-bitrate': 1000
                    }
                },
                {
                    kind: 'video',
                    mimeType: 'video/h264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '4d0032',
                        'level-asymmetry-allowed': 1,
                        'x-google-start-bitrate': 1000
                    }
                },
                {
                    kind: 'video',
                    mimeType: 'video/h264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                        'level-asymmetry-allowed': 1,
                        'x-google-start-bitrate': 1000
                    }
                }
            ] as RtpCodecCapability[]
        },

        // mediasoup WebRtcServer options for WebRTC endpoints (mediasoup-client,
        // libmediasoupclient).
        // See https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcServerOptions
        // NOTE: mediasoup-demo/server/lib/Room.js will increase this port for
        // each mediasoup Worker since each Worker is a separate process.
        webRtcServerOptions: {
            listenInfos: [
                {
                    protocol: 'udp',
                    ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
                    port: 44444
                },
                {
                    protocol: 'tcp',
                    ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
                    port: 44444
                }
            ],
        } as WebRtcServerOptions,

        // mediasoup WebRtcTransport options for WebRTC endpoints (mediasoup-client,
        // libmediasoupclient).
        // See https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
        webRtcTransportOptions: {
            // listenIps is not needed since webRtcServer is used.
            // However passing MEDIASOUP_USE_WEBRTC_SERVER=false will change it.
            listenIps: [
                {
                    ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP
                }
            ],
            initialAvailableOutgoingBitrate: 1000000,
            minimumAvailableOutgoingBitrate: 600000,
            maxSctpMessageSize: 262144,
            // Additional options that are not part of WebRtcTransportOptions.
            maxIncomingBitrate: 1500000
        },

        // mediasoup PlainTransport options for legacy RTP endpoints (FFmpeg,
        // GStreamer).
        // See https://mediasoup.org/documentation/v3/mediasoup/api/#PlainTransportOptions
        plainTransportOptions: {
            listenIp:
            {
                ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP
            },
            maxSctpMessageSize: 262144
        }
    }
};

export default config;