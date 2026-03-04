import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { http, createPublicClient, erc20Abi, getAddress } from "viem";
import { mainnet } from "viem/chains";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ZIP_PATH = path.join(ROOT_DIR, "external-sources/kleros-mainnet.zip");
const ADDRESSES_DIR = path.join(ROOT_DIR, "data/addresses/evm/1");
const TOKENS_DIR = path.join(ROOT_DIR, "data/tokens/evm/1");
const RPC_FILE = path.join(ROOT_DIR, "data/rpcs/evm/1.json");
const CHAIN_ID = 1;

const DRY_RUN = process.argv.includes("--dry-run");
const TODAY = new Date().toISOString().split("T")[0];

interface TagEntry {
	address: string;
	nametag: string;
}

interface TokenEntry {
	address: string;
	name: string;
	symbol: string;
	projectName: string;
	website: string;
}

interface Stats {
	tagsTotal: number;
	tagsDeduplicated: number;
	tagsInvalidAddress: number;
	addressesCreated: number;
	addressesSkipped: number;
	tokensTotal: number;
	tokensInvalidAddress: number;
	tokensSkippedNoDecimals: number;
	tokensSkippedHighDecimals: number;
	tokensCreated: number;
	tokensEnriched: number;
	tokensSkippedExisting: number;
	errors: string[];
}

function isValidUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

function listZipEntries(zipPath: string): string[] {
	const output = execSync(`unzip -l "${zipPath}"`, { encoding: "utf-8" });
	const lines = output.split("\n");
	const entries: string[] = [];
	for (const line of lines) {
		const match = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
		if (match) {
			const name = match[1].trim();
			if (name && !name.endsWith("/")) {
				entries.push(name);
			}
		}
	}
	return entries;
}

function extractFile(zipPath: string, entryName: string): string {
	return execSync(`unzip -p "${zipPath}" "${entryName}"`, {
		encoding: "utf-8",
		maxBuffer: 100 * 1024 * 1024,
	});
}

function extractAndParseTags(zipPath: string): Map<string, TagEntry> {
	const entries = listZipEntries(zipPath);
	const tags = new Map<string, TagEntry>();

	const batchedFiles = entries
		.filter((e) => e.includes("batched_tags/") && e.endsWith(".csv"))
		.sort();
	const singleFiles = entries
		.filter((e) => e.includes("Single_tags/") && e.endsWith(".csv"))
		.sort();

	let totalParsed = 0;
	let invalidAddresses = 0;

	// Process batched tags first
	for (const file of batchedFiles) {
		console.log(`  Parsing ${path.basename(file)}...`);
		const csv = extractFile(zipPath, file);
		const records = parse(csv, { columns: true, skip_empty_lines: true });
		for (const row of records) {
			const rawAddress = row.Address?.trim();
			const nametag = row.Nametag?.trim();
			if (!rawAddress || !nametag) continue;

			totalParsed++;
			let checksummed: string;
			try {
				checksummed = getAddress(rawAddress);
			} catch {
				invalidAddresses++;
				continue;
			}

			const key = checksummed.toLowerCase();
			tags.set(key, { address: key, nametag });
		}
	}

	// Process single tags second (override batched)
	for (const file of singleFiles) {
		console.log(`  Parsing ${path.basename(file)}...`);
		const csv = extractFile(zipPath, file);
		const records = parse(csv, { columns: true, skip_empty_lines: true });
		for (const row of records) {
			const rawAddress = row.Address?.trim();
			const nametag = row.Nametag?.trim();
			if (!rawAddress || !nametag) continue;

			totalParsed++;
			let checksummed: string;
			try {
				checksummed = getAddress(rawAddress);
			} catch {
				invalidAddresses++;
				continue;
			}

			const key = checksummed.toLowerCase();
			tags.set(key, { address: key, nametag });
		}
	}

	console.log(
		`\n  Tags parsed: ${totalParsed}, deduplicated: ${tags.size}, invalid addresses: ${invalidAddresses}\n`,
	);
	return tags;
}

function extractAndParseTokens(zipPath: string): TokenEntry[] {
	const entries = listZipEntries(zipPath);
	const tokenFiles = entries.filter(
		(e) => e.includes("Tokens/") && e.endsWith(".csv"),
	);

	const tokens: TokenEntry[] = [];
	let invalidAddresses = 0;

	for (const file of tokenFiles) {
		console.log(`  Parsing ${path.basename(file)}...`);
		const csv = extractFile(zipPath, file);
		const records = parse(csv, { columns: true, skip_empty_lines: true });
		for (const row of records) {
			const rawAddress = (row["contract address"] ?? "").trim();
			const name = (row["token name"] ?? "").trim();
			const symbol = (row.symbol ?? "").trim();
			const projectName = (row["project name"] ?? "").trim();
			const website = (row["token website"] ?? "").trim();

			if (!rawAddress || !name || !symbol) continue;

			let checksummed: string;
			try {
				checksummed = getAddress(rawAddress);
			} catch {
				invalidAddresses++;
				continue;
			}

			tokens.push({
				address: checksummed.toLowerCase(),
				name: name.length > 64 ? name.slice(0, 64) : name,
				symbol: symbol.length > 16 ? symbol.slice(0, 16) : symbol,
				projectName,
				website: isValidUrl(website) ? website : "",
			});
		}
	}

	console.log(
		`\n  Tokens parsed: ${tokens.length}, invalid addresses: ${invalidAddresses}\n`,
	);
	return tokens;
}

function getRpcUrl(): string {
	const rpcData = JSON.parse(fs.readFileSync(RPC_FILE, "utf-8"));
	const noTrackingEndpoint = rpcData.endpoints?.find(
		(e: { tracking: string; url: string }) =>
			e.tracking === "none" && e.url.startsWith("https://"),
	);
	if (!noTrackingEndpoint) {
		console.error("No tracking=none RPC endpoint found in", RPC_FILE);
		process.exit(1);
	}
	return noTrackingEndpoint.url;
}

async function fetchDecimals(
	addresses: string[],
	rpcUrl: string,
): Promise<Map<string, number>> {
	const client = createPublicClient({
		chain: mainnet,
		transport: http(rpcUrl),
	});

	const decimalsMap = new Map<string, number>();
	const BATCH_SIZE = 100;
	const DELAY_MS = 200;
	const totalBatches = Math.ceil(addresses.length / BATCH_SIZE);

	console.log(
		`  Fetching decimals for ${addresses.length} tokens in ${totalBatches} batches...`,
	);

	for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
		const batch = addresses.slice(i, i + BATCH_SIZE);
		const batchNum = Math.floor(i / BATCH_SIZE) + 1;

		if (batchNum % 10 === 0 || batchNum === totalBatches) {
			console.log(`    Batch ${batchNum}/${totalBatches}...`);
		}

		try {
			const results = await client.multicall({
				contracts: batch.map((addr) => ({
					address: getAddress(addr) as `0x${string}`,
					abi: erc20Abi,
					functionName: "decimals",
				})),
				allowFailure: true,
			});

			for (let j = 0; j < results.length; j++) {
				const result = results[j];
				if (result.status === "success") {
					decimalsMap.set(batch[j], Number(result.result));
				}
			}
		} catch (err) {
			console.warn(
				`    Batch ${batchNum} failed: ${err instanceof Error ? err.message : err}`,
			);
		}

		if (i + BATCH_SIZE < addresses.length) {
			await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
		}
	}

	console.log(
		`  Fetched decimals for ${decimalsMap.size}/${addresses.length} tokens\n`,
	);
	return decimalsMap;
}

function processAddresses(tags: Map<string, TagEntry>, stats: Stats): void {
	fs.mkdirSync(ADDRESSES_DIR, { recursive: true });

	for (const [key, tag] of tags) {
		const filePath = path.join(ADDRESSES_DIR, `${key}.json`);

		if (fs.existsSync(filePath)) {
			stats.addressesSkipped++;
			continue;
		}

		const data: Record<string, unknown> = {
			address: tag.address,
			chainId: CHAIN_ID,
			label: tag.nametag,
			source: ["kleros", TODAY],
		};

		if (!DRY_RUN) {
			fs.writeFileSync(filePath, `${JSON.stringify(data, null, "\t")}\n`);
		}
		stats.addressesCreated++;
	}
}

function processTokens(
	tokens: TokenEntry[],
	decimalsMap: Map<string, number>,
	stats: Stats,
): void {
	fs.mkdirSync(TOKENS_DIR, { recursive: true });

	for (const token of tokens) {
		const filePath = path.join(TOKENS_DIR, `${token.address}.json`);
		const decimals = decimalsMap.get(token.address);

		if (fs.existsSync(filePath)) {
			// Enrich existing file with project and links if missing
			try {
				const existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				let enriched = false;

				if (!existing.project && token.projectName) {
					existing.project = { name: token.projectName };
					enriched = true;
				}

				if ((!existing.links || existing.links.length === 0) && token.website) {
					existing.links = [{ name: "Website", url: token.website }];
					enriched = true;
				}

				if (enriched) {
					if (!DRY_RUN) {
						fs.writeFileSync(
							filePath,
							`${JSON.stringify(existing, null, "\t")}\n`,
						);
					}
					stats.tokensEnriched++;
				} else {
					stats.tokensSkippedExisting++;
				}
			} catch (err) {
				stats.errors.push(
					`Failed to enrich ${token.address}: ${err instanceof Error ? err.message : err}`,
				);
				stats.tokensSkippedExisting++;
			}
			continue;
		}

		if (decimals === undefined) {
			stats.tokensSkippedNoDecimals++;
			continue;
		}

		if (decimals > 18) {
			stats.tokensSkippedHighDecimals++;
			continue;
		}

		const data: Record<string, unknown> = {
			address: token.address,
			chainId: CHAIN_ID,
			name: token.name,
			symbol: token.symbol,
			decimals,
			source: ["kleros", TODAY],
		};

		if (token.projectName) {
			data.project = { name: token.projectName };
		}

		if (token.website) {
			data.links = [{ name: "Website", url: token.website }];
		}

		if (!DRY_RUN) {
			fs.writeFileSync(filePath, `${JSON.stringify(data, null, "\t")}\n`);
		}
		stats.tokensCreated++;
	}
}

function printReport(stats: Stats): void {
	console.log("\n=== Import Report ===\n");
	console.log(`Mode: ${DRY_RUN ? "DRY RUN (no files written)" : "LIVE"}`);
	console.log("\nAddresses:");
	console.log(`  Total tags (deduplicated): ${stats.tagsDeduplicated}`);
	console.log(`  Invalid addresses skipped: ${stats.tagsInvalidAddress}`);
	console.log(`  Created: ${stats.addressesCreated}`);
	console.log(`  Skipped (already exist): ${stats.addressesSkipped}`);
	console.log("\nTokens:");
	console.log(`  Total parsed: ${stats.tokensTotal}`);
	console.log(`  Invalid addresses skipped: ${stats.tokensInvalidAddress}`);
	console.log(`  Created: ${stats.tokensCreated}`);
	console.log(`  Enriched (added project/links): ${stats.tokensEnriched}`);
	console.log(
		`  Skipped (already exist, no enrichment): ${stats.tokensSkippedExisting}`,
	);
	console.log(
		`  Skipped (no decimals from RPC): ${stats.tokensSkippedNoDecimals}`,
	);
	console.log(`  Skipped (decimals > 18): ${stats.tokensSkippedHighDecimals}`);

	if (stats.errors.length > 0) {
		console.log(`\nErrors (${stats.errors.length}):`);
		for (const err of stats.errors.slice(0, 20)) {
			console.log(`  - ${err}`);
		}
		if (stats.errors.length > 20) {
			console.log(`  ... and ${stats.errors.length - 20} more`);
		}
	}

	console.log("\nDone!");
}

async function main() {
	console.log(`\nKleros Mainnet v1 Import${DRY_RUN ? " (DRY RUN)" : ""}\n`);

	// Validate ZIP exists
	if (!fs.existsSync(ZIP_PATH)) {
		console.error(`ZIP file not found: ${ZIP_PATH}`);
		process.exit(1);
	}

	const stats: Stats = {
		tagsTotal: 0,
		tagsDeduplicated: 0,
		tagsInvalidAddress: 0,
		addressesCreated: 0,
		addressesSkipped: 0,
		tokensTotal: 0,
		tokensInvalidAddress: 0,
		tokensSkippedNoDecimals: 0,
		tokensSkippedHighDecimals: 0,
		tokensCreated: 0,
		tokensEnriched: 0,
		tokensSkippedExisting: 0,
		errors: [],
	};

	// 1. Parse tags
	console.log("--- Parsing address tags ---\n");
	const tags = extractAndParseTags(ZIP_PATH);
	stats.tagsDeduplicated = tags.size;

	// 2. Parse tokens
	console.log("--- Parsing tokens ---\n");
	const tokens = extractAndParseTokens(ZIP_PATH);
	stats.tokensTotal = tokens.length;

	// 3. Collect existing token addresses to skip RPC calls for them
	const existingTokenAddresses = new Set<string>();
	if (fs.existsSync(TOKENS_DIR)) {
		for (const file of fs.readdirSync(TOKENS_DIR)) {
			if (file.endsWith(".json")) {
				existingTokenAddresses.add(file.replace(".json", ""));
			}
		}
	}

	// 4. Fetch decimals for new tokens only
	const newTokenAddresses = tokens
		.map((t) => t.address)
		.filter((addr) => !existingTokenAddresses.has(addr));

	// Deduplicate addresses for RPC calls
	const uniqueNewAddresses = [...new Set(newTokenAddresses)];

	let decimalsMap = new Map<string, number>();
	if (uniqueNewAddresses.length > 0) {
		console.log("--- Fetching token decimals via RPC ---\n");
		const rpcUrl = getRpcUrl();
		console.log(`  Using RPC: ${rpcUrl}\n`);
		decimalsMap = await fetchDecimals(uniqueNewAddresses, rpcUrl);
	} else {
		console.log("--- No new tokens to fetch decimals for ---\n");
	}

	// 5. Process addresses
	console.log("--- Processing addresses ---\n");
	processAddresses(tags, stats);

	// 6. Process tokens
	console.log("--- Processing tokens ---\n");
	processTokens(tokens, decimalsMap, stats);

	// 7. Print report
	printReport(stats);
}

main().catch((err) => {
	console.error("Import failed:", err);
	process.exit(1);
});
