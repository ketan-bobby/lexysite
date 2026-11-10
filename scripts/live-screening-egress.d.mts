export function withOneLiveScreeningRequest<T>(fn: () => Promise<T>): Promise<T>;
export function liveScreeningRequestCount(): number;
