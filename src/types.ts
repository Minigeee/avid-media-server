import { Socket as _Socket } from 'socket.io';
import { Media_ClientToServerEvents, Media_ServerToClientEvents } from 'avid-types';

export type Socket = _Socket<Media_ClientToServerEvents, Media_ServerToClientEvents>;