# Build Instructions

## For Development

Run the bot directly with TypeScript:

```bash
npm start
# or
pnpm start
```

## For Production

1. Install dependencies:

```bash
npm install
# or
pnpm install
```

2. Build the TypeScript code to JavaScript:

```bash
npm run build
# or
pnpm run build
```

3. Start the bot using the compiled code:

```bash
node start.js
```

The `start.js` file will load the compiled JavaScript from the `dist/` folder.

## Server Configuration

If your server requires a startup file, use `start.js` as the entry point. Make sure to:

1. Run `npm install` to install dependencies
2. Run `npm run build` to compile TypeScript to JavaScript
3. Configure your server to run `node start.js`

The build process compiles all TypeScript files from the project into JavaScript files in the `dist/` directory.
