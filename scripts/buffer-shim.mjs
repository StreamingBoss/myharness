// isomorphic-git expects Node's global Buffer; esbuild replaces its free uses with this import.
export { Buffer } from 'buffer';
