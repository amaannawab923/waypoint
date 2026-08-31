import chalk from 'chalk';
import detectPort from 'detect-port';

// 11212, not this template's conventional 1212 default — moved to avoid
// colliding with another project's dev server on the same machine.
const port = process.env.PORT || '11212';

detectPort(port, (_err, availablePort) => {
  if (port !== String(availablePort)) {
    throw new Error(
      chalk.whiteBright.bgRed.bold(
        `Port "${port}" on "localhost" is already in use. Please use another port. ex: PORT=4343 npm start`,
      ),
    );
  } else {
    process.exit(0);
  }
});
