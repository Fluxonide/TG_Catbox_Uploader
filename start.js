// Startup file for production server
// This file loads the compiled JavaScript from the dist folder

import('./dist/index.js').catch(err => {
  console.error('Failed to start the bot:', err)
  process.exit(1)
})
