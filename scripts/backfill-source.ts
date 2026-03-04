import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const TODAY = new Date().toISOString().split("T")[0];
const DEFAULT_SOURCE: [string, string] = ["openscan", TODAY];

function backfillDir(dir: string): number {
	let count = 0;
	if (!fs.existsSync(dir)) return count;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			count += backfillDir(fullPath);
		} else if (entry.name.endsWith(".json")) {
			try {
				const data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
				if (!data.source) {
					data.source = DEFAULT_SOURCE;
					fs.writeFileSync(fullPath, `${JSON.stringify(data, null, "\t")}\n`);
					count++;
				}
			} catch (e) {
				console.warn(`Warning: Failed to process ${fullPath}: ${e}`);
			}
		}
	}
	return count;
}

console.log(
	`\nBackfilling source field with ${JSON.stringify(DEFAULT_SOURCE)}\n`,
);

const dirs = [
	"data/addresses",
	"data/tokens",
	"data/apps",
	"data/orgs",
	"data/events",
	"data/rpcs",
];

let total = 0;
for (const dir of dirs) {
	const fullDir = path.join(ROOT_DIR, dir);
	const count = backfillDir(fullDir);
	console.log(`  ${dir}: ${count} files updated`);
	total += count;
}

console.log(`\nDone! ${total} files updated.\n`);
