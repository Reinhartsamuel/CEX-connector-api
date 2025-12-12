dev:
	reflex -r '\.to$$' -s -- sh -c 'bun run dev'

start-worker:
	reflex -r '\.to$$' -s -- sh -c 'bun run src/workers/gateWorkerRunner.ts'
