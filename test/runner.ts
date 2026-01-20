import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Recursively find all .test.ts files in the test directory
function findTestFiles(dir: string): string[] {
    const files: string[] = [];
    const items = readdirSync(dir);

    for (const item of items) {
        const fullPath = join(dir, item);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...findTestFiles(fullPath));
        } else if (item.endsWith('.test.ts')) {
            files.push(fullPath);
        }
    }

    return files;
}

const testDir = join(process.cwd(), 'test');
const testFiles = findTestFiles(testDir);

// Import all test files sequentially with proper error handling
async function runTests() {
    for (const file of testFiles) {
        try {
            await import(pathToFileURL(file).href);
        } catch (error) {
            console.error(`Failed to import ${file}:`, error);
            process.exit(1);
        }
    }
}

runTests();
