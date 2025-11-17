import { Hono } from 'hono'
import { getConnInfo } from 'hono/bun'
import { ipRestriction } from 'hono/ip-restriction'
import gateRouter from './routes/gateRoutes'
import { logger } from 'hono/logger'

const app = new Hono()

// app.use(
//   '*',
//   ipRestriction(getConnInfo, {
//     denyList: [],
//     allowList: ['127.0.0.1', '::1'],
//   })
// )

app.use(logger())
app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.route('/gate', gateRouter)

const port = parseInt(process.env['PORT'] || '1122')

console.log(`Server starting on port ${port}`)

Bun.serve({
  port,
  fetch: app.fetch,
  // maxRequestBodySize: 1024 * 1024 * 200, // your value here
})
