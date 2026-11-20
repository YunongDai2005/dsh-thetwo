import { DshLibrary } from '../../lib/library.js'
import { openHarness } from '../runtime.mjs'

// Used only with a temporary test directory. The parent terminates this process
// at a durability boundary instead of allowing normal plugin/store disposal.
const app = await openHarness(process.argv[2])
const library = await DshLibrary.open(app.ctx, app.root)
library.save = async () => {
  process.send({ phase: 'native-log-flushed' })
  await new Promise(() => {})
}
process.on('message', snapshot => {
  library.accept(snapshot).catch(error => {
    process.send({ error: error.message })
    process.exitCode = 1
    process.disconnect()
  })
})
process.send({ phase: 'ready' })
