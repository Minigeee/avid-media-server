import { Request, Response, NextFunction, RequestHandler } from 'express';
import { Room } from './rooms';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;


const wrapper = {
	api: (fn: AsyncRequestHandler): RequestHandler => {
		return (req: Request, res: Response, next: NextFunction): void => {
			fn(req, res, next).then(() => next()).catch(next);
		};
	},
	event: <T extends (...args: any) => any>(room: Room, participant_id: string | null, handler: T): ((...args: Parameters<T>) => void) => {
		const handleError = (err: any) => {
			room.log.error(err, { sender: participant_id });
		};
	
		return (...args: any) => {
			try {
				const ret = handler.apply(this, args);
				if (ret && typeof ret.catch === "function") {
					// async handler
					ret.catch(handleError);
				}
			} catch (e) {
				// sync handler
				handleError(e);
			}
		};
	},
};
export default wrapper;