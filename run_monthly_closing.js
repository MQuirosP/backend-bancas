const { executeMonthlyClosing } = require('./dist/jobs/monthlyClosing.job');

async function run() {
    try {
        const result = await executeMonthlyClosing(undefined, '2025-12');
        console.log('Monthly closing executed successfully:', result);
    } catch (error) {
        console.error('Error executing monthly closing:', error);
        process.exit(1);
    }
}

run();
