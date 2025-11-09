import chalk from "chalk";

export function info(message: string) {
  console.log(chalk.cyan("[INFO]"), message);
}

export function success(message: string) {
  console.log(chalk.green("[OK]"), message);
}

export function warn(message: string) {
  console.log(chalk.yellow("[WARN]"), message);
}

export function error(message: string) {
  console.error(chalk.red("[ERROR]"), message);
}


