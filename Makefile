dev:
	reflex -r '\.to$$' -s -- sh -c 'bun run src/workers/gateWorker.ts'
