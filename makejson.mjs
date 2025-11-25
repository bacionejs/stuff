#!/usr/bin/env node
/**
 * Script to process js13kGames entries for code analysis.
 *
 * Use case: Help people find tech (e.g., webgl, sonant) examples used by high-rated repos.
 *
 * This script is a multi-step process:
 * 1. `games`: Fetches metadata for all forked game repositories from the js13kGames GitHub org.
 *    - Filters for repos that are forks and stores their name, star count, and default branch.
 *    - Saves this data to `games.json`.
 * 2. `download`: Downloads the source code of each game as a zip archive from GitHub.
 *    - Places archives in the `zips/` directory.
 * 3. `unzip`: Unzips each archive into its own directory under `unzipped/`.
 *    - Cleans up the unzipped files, removing `node_modules` and keeping only source files
 *      (.js, .ts, .html, .htm).
 * 4. `tokens`: Analyzes the source code to extract unique identifiers (tokens).
 *    - Creates an inverted index mapping tokens to the games they appear in.
 *    - Saves this index to `tokens.json`.
 *
 * Each step depends on the previous one and should be run in order.
 * Requires a GITHUB_TOKEN environment variable for API access.
 */

// --- Imports ---
import { mkdirSync, existsSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { Octokit } from "@octokit/rest";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import pLimit from "p-limit";

// --- Constants ---
const GITHUB_ORG = "js13kGames";
const GAMES_REPO = "games"; // The repo containing the list of all game forks

// Configuration
const ZIP_DIR = "zips";
const UNZIP_DIR = "unzipped";
const TOKENS_FILE = "tokens.json";
const GAMES_FILE = "games.json";

// Concurrency settings
const MAX_API_PARALLEL = 10; // For GitHub API calls
const MAX_DOWNLOAD_PARALLEL = 10; // For downloads and unzips
const THREAD_COUNT = 8; // For CPU-intensive tokenization

// --- Global Initializations ---
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const run = promisify(exec);

// --- Worker Thread Logic ---
if (!isMainThread) {
  processWorkerTask();
}

/**
 * The main function for the worker thread. It processes a list of files to extract tokens.
 */
function processWorkerTask() {
  const { files } = workerData;
  const tokenToRepos = new Map();
  const repoSet = new Set();

  for (const filePath of files) {
    try {
      // Skip very large files to avoid memory issues and irrelevant data
      const stat = statSync(filePath);
      if (stat.size > 500 * 1024) continue; // 500KB limit

      const repoName = extractRepoNameFromFilePath(filePath);
      if (!repoName) continue;
      repoSet.add(repoName);

      const buffer = readFileSync(filePath);
      let text = buffer.toString("utf8");

      // Filter out noisy, non-code strings like base64 data URIs or long hashes
      const patterns = [
        /base64,[A-Za-z0-9+/=]+/g, // base64 data
        /["'`][A-Za-z0-9+/=]{40,}["'`]/g, // Long strings that look like hashes/keys
        /["'`][A-Za-z0-9_@#%$*^!<>?:;.,\\|~`-]{40,}["'`]/g, // More generic long strings
      ];
      for (const pattern of patterns) {
        text = text.replace(pattern, " ");
      }

      // Extract potential identifiers (tokens)
      const tokens = text.match(/\b[a-zA-Z0-9_]+\b/g);
      if (!tokens) continue;

      const uniqueTokensInFile = new Set();
      for (const token of tokens) {
        // Filter out undesirable tokens
        if (token.length > 50 || token.length < 3) continue; // Too long or too short
        if (/^[0-9_]/.test(token)) continue; // Starts with a number or underscore
        if (token === token.toUpperCase()) continue; // Likely a constant, not a library/API name
        uniqueTokensInFile.add(token);
      }

      for (const token of uniqueTokensInFile) {
        if (!tokenToRepos.has(token)) {
          tokenToRepos.set(token, new Set());
        }
        tokenToRepos.get(token).add(repoName);
      }
    } catch (error) {
      // Log errors but don't crash the worker for a single file
      console.error(`Worker failed to process file ${filePath}:`, error.message);
    }
  }

  // Post the results back to the main thread
  parentPort.postMessage({
    repos: [...repoSet],
    tokens: [...tokenToRepos.entries()].map(([token, set]) => [token, [...set]]),
  });

  process.exit(0);
}

/**
 * Extracts the repository name from a file path within the UNZIP_DIR.
 * @param {string} filePath - The full path to the file.
 * @returns {string|null} The repository name or null if not found.
 */
function extractRepoNameFromFilePath(filePath) {
  const parts = filePath.split(path.sep);
  const unzipDirIndex = parts.indexOf(UNZIP_DIR);
  return unzipDirIndex !== -1 && parts[unzipDirIndex + 1] ? parts[unzipDirIndex + 1] : null;
}

// --- Main Thread Functions ---

/**
 * Recursively walks a directory to find all files.
 * @param {string} dir - The directory to walk.
 * @returns {string[]} An array of full file paths.
 */
function walk(dir) {
  let files = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files = files.concat(walk(fullPath));
        } else {
          files.push(fullPath);
        }
      } catch (error) {
        console.warn(`Could not stat ${fullPath}, skipping:`, error.message);
      }
    }
  } catch (error) {
    console.error(`Could not read directory ${dir}:`, error.message);
  }
  return files;
}

/**
 * Splits an array into a specified number of chunks.
 * @param {any[]} array - The array to split.
 * @param {number} parts - The number of chunks.
 * @returns {any[][]} An array of chunks.
 */
function splitArray(array, parts) {
  const chunkSize = Math.ceil(array.length / parts);
  return Array.from({ length: parts }, (_, i) =>
    array.slice(i * chunkSize, (i + 1) * chunkSize)
  );
}

/**
 * Runs a worker thread to process a chunk of files.
 * @param {string[]} files - The list of files for the worker to process.
 * @returns {Promise<object>} A promise that resolves with the worker's results.
 */
function runWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { files } });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

/**
 * Fetches the list of top-level directories (game repos) from the js13kGames/games repo.
 * @returns {Promise<string[]>} A list of repository names.
 */
async function getGameRepoList() {
  console.log(`Fetching directory tree from ${GITHUB_ORG}/${GAMES_REPO}...`);
  const { data } = await octokit.git.getTree({
    owner: GITHUB_ORG,
    repo: GAMES_REPO,
    tree_sha: "main",
    recursive: true,
  });

  if (!data.tree) {
    throw new Error("Could not retrieve repository tree.");
  }

  // Filter for top-level directories under "games/"
  return data.tree
    .filter(entry => entry.type === "tree" && /^games\/[^/]+$/.test(entry.path))
    .map(entry => entry.path.replace(/^games\//, ""));
}

/**
 * Generates the games.json file by fetching metadata for each game repository.
 * @param {string[]} repoNames - A list of repository names to process.
 * @param {pLimit.Limit} limiter - An instance of p-limit for rate limiting API calls.
 * @returns {Promise<object[]>} The generated game data.
 */
async function generateGamesFile(repoNames, limiter) {
  const gamesData = [];
  const promises = repoNames.map(repoName =>
    limiter(async () => {
      try {
        const { data: repoDetails } = await octokit.repos.get({
          owner: GITHUB_ORG,
          repo: repoName,
        });

        // Skip repos that are not forks, as we're interested in community submissions.
        if (!repoDetails.parent) {
//           console.warn(`Skipping orphaned '${repoName}'`);
          return;
        }

        gamesData.push({
          name: repoDetails.name,
          stars: repoDetails.parent.stargazers_count,
          default_branch: repoDetails.default_branch,
        });
      } catch (error) {
        console.warn(`Error fetching metadata for '${repoName}': ${error.message}`);
      }
    })
  );

  await Promise.all(promises);

  // Sort by stars descending to prioritize more popular games
  gamesData.sort((a, b) => b.stars - a.stars);

  writeFileSync(GAMES_FILE, JSON.stringify(gamesData, null, 2));
  console.log(`Saved ${gamesData.length} games to ${GAMES_FILE}`);
  return gamesData;
}

/**
 * Generates the tokens.json file by tokenizing all source files using worker threads.
 */
async function generateTokensFile() {
  console.log("Scanning files in", UNZIP_DIR);
  const allFiles = walk(UNZIP_DIR);
  console.log(`Found ${allFiles.length} files to process.`);

  const fileChunks = splitArray(allFiles, THREAD_COUNT);
  console.log(`Processing files across ${THREAD_COUNT} threads...`);
  const results = await Promise.all(fileChunks.map(runWorker));

  console.log("Aggregating results from workers...");
  const tokenToRepos = new Map();
  const allRepos = new Set();
  for (const result of results) {
    result.repos.forEach(repo => allRepos.add(repo));
    for (const [token, repos] of result.tokens) {
      if (!tokenToRepos.has(token)) {
        tokenToRepos.set(token, new Set());
      }
      const existingRepos = tokenToRepos.get(token);
      repos.forEach(repo => existingRepos.add(repo));
    }
  }

  const sortedRepos = [...allRepos].sort();
  const repoIndexMap = new Map(sortedRepos.map((repo, i) => [repo, i]));

  const tokenEntries = [...tokenToRepos.entries()]
    // Filter for tokens that appear in at least 2 repos to reduce noise
    .filter(([, repos]) => repos.size >= 2)
    // Sort tokens alphabetically
    .sort(([tokenA], [tokenB]) => tokenA.localeCompare(tokenB))
    // Map repos to their index in the sorted list
    .map(([token, repos]) => [
      token,
      [...repos].map(repo => repoIndexMap.get(repo)).sort((a, b) => a - b),
    ]);

  const output = {
    repos: sortedRepos,
    tokens: tokenEntries,
  };

  writeFileSync(TOKENS_FILE, JSON.stringify(output));
  console.log(`Saved token index to ${TOKENS_FILE}`);
}

/**
 * Downloads a repository's source code as a zip file.
 * @param {object} game - A game object with `name` and `default_branch` properties.
 * @returns {Promise<boolean>} True if download was successful or already exists.
 */
async function downloadRepo({ name, default_branch }) {
  const zipPath = path.join(ZIP_DIR, `${name}.zip`);
  if (existsSync(zipPath)) {
    return true; // Already downloaded
  }

  const url = `https://github.com/${GITHUB_ORG}/${name}/archive/refs/heads/${default_branch}.zip`;
  console.log(`Downloading: ${name}`);
  try {
    await run(`curl -sfL "${url}" -o "${zipPath}"`);
    return true;
  } catch (error) {
    console.error(`Failed to download ${name}:`, error.message);
    rmSync(zipPath, { force: true }); // Clean up failed download
    return false;
  }
}

/**
 * Unzips a repository's archive and cleans up the contents.
 * @param {object} game - A game object with a `name` property.
 * @returns {Promise<boolean>} True if unzip was successful.
 */
async function unzipRepo({ name }) {
  const zipPath = path.join(ZIP_DIR, `${name}.zip`);
  const outPath = path.join(UNZIP_DIR, name);

  if (!existsSync(zipPath)) {
    console.warn(`Zip file for ${name} not found, skipping unzip.`);
    return false;
  }

  // Clean up previous extraction if it exists
  if (existsSync(outPath)) {
    rmSync(outPath, { recursive: true, force: true });
  }
  mkdirSync(outPath, { recursive: true });

  console.log(`Unzipping: ${name}`);
  try {
    // Unzip the archive
    await run(`unzip -q "${zipPath}" -d "${outPath}"`);

    // Clean up unwanted files and directories
    // Remove all symlinks
    await run(`find "${outPath}" -type l -exec rm {} +`);
    // Remove all node_modules folders, which are bulky and not source code
    await run(`find "${outPath}" -type d -name "node_modules" -exec rm -rf {} +`);
    // Remove non-source files to focus analysis
    await run(`find "${outPath}" -type f ! -iname '*.js' ! -iname '*.ts' ! -iname '*.html' ! -iname '*.htm' -delete`);

    return true;
  } catch (error) {
    console.error(`Failed to unzip and clean ${name}:`, error.message);
    // Clean up failed extraction
    rmSync(outPath, { recursive: true, force: true });
    return false;
  }
}

/**
 * Logs the current GitHub API rate limit status.
 */
async function logRateLimit() {
  try {
    const { data } = await octokit.rateLimit.get();
    console.log(`GitHub API rate limit: ${data.rate.remaining}/${data.rate.limit} remaining. Resets at ${new Date(data.rate.reset * 1000).toLocaleTimeString()}`);
  } catch (error) {
    console.warn("Could not fetch GitHub API rate limit.", error.message);
  }
}

/**
 * Prints usage instructions and exits.
 * @param {string} [errorMessage] - An optional error message to display.
 */
function printUsageAndExit(errorMessage) {
  const SCRIPT_NAME = path.basename(process.argv[1]);
  const VALID_COMMANDS = ['games', 'download', 'unzip', 'tokens'];

  if (errorMessage) {
    console.error(`\nError: ${errorMessage}`);
  }
  console.error(`\nUsage: node ${SCRIPT_NAME} <command>`);
  console.error(`Available commands: ${VALID_COMMANDS.join(', ')}`);
  console.error("\nNote: Each step depends on the previous one and should be run in order.");
  process.exit(1);
}

/**
 * Main execution function.
 * @param {string} command - The command to execute.
 */
async function main(command) {
  if (!command) {
    printUsageAndExit();
  }

  // Pre-execution checks and setup
  if (!process.env.GITHUB_TOKEN) {
    console.error("Error: GITHUB_TOKEN environment variable is not set.");
    process.exit(1);
  }

  switch (command) {
    case 'games': {
      console.log("--- Step 1: Generating games list ---");
      console.log("Warning: This step consumes one GitHub API call per repository.");
      await logRateLimit();
      const repoNames = await getGameRepoList();
      console.log(`Found ${repoNames.length} potential game repos. Fetching metadata to create ${GAMES_FILE}...`);
      const limiter = pLimit(MAX_API_PARALLEL);
      await generateGamesFile(repoNames, limiter);
      console.log(`${GAMES_FILE} created successfully.`);
      await logRateLimit();
      break;
    }

    case 'download': {
      console.log("--- Step 2: Downloading game sources ---");
      if (!existsSync(GAMES_FILE)) {
        return printUsageAndExit(`${GAMES_FILE} not found. Please run the 'games' command first.`);
      }
      console.log("Warning: This will download a large amount of data.");
      mkdirSync(ZIP_DIR, { recursive: true });
      const gamesToDownload = JSON.parse(readFileSync(GAMES_FILE, "utf8"));
      console.log(`Downloading ${gamesToDownload.length} game sources to ${ZIP_DIR}/...`);
      const limiter = pLimit(MAX_DOWNLOAD_PARALLEL);
      const tasks = gamesToDownload.map(game => limiter(() => downloadRepo(game)));
      await Promise.all(tasks);
      console.log("Download complete.");
      break;
    }

    case 'unzip': {
      console.log("--- Step 3: Unzipping and cleaning sources ---");
      if (!existsSync(GAMES_FILE)) {
        return printUsageAndExit(`${GAMES_FILE} not found. Please run the 'games' command first.`);
      }
      if (!existsSync(ZIP_DIR) || readdirSync(ZIP_DIR).length === 0) {
        return printUsageAndExit(`${ZIP_DIR}/ is empty or not found. Please run the 'download' command first.`);
      }
      mkdirSync(UNZIP_DIR, { recursive: true });
      const gamesToUnzip = JSON.parse(readFileSync(GAMES_FILE, "utf8"));
      console.log(`Unzipping ${gamesToUnzip.length} games to ${UNZIP_DIR}/...`);
      const limiter = pLimit(MAX_DOWNLOAD_PARALLEL);
      const tasks = gamesToUnzip.map(game => limiter(() => unzipRepo(game)));
      await Promise.all(tasks);
      console.log("Unzip and clean complete.");
      break;
    }

    case 'tokens': {
      console.log("--- Step 4: Generating search tokens ---");
      if (!existsSync(UNZIP_DIR) || readdirSync(UNZIP_DIR).length === 0) {
        return printUsageAndExit(`${UNZIP_DIR}/ is empty or not found. Please run the 'unzip' command first.`);
      }
      console.log(`Generating search tokens from ${UNZIP_DIR}/ to create ${TOKENS_FILE}...`);
      await generateTokensFile();
      console.log("Token generation complete.");
      break;
    }

    default:
      printUsageAndExit(`Unknown command "${command}"`);
  }
}

// --- Script Entry Point ---
process.on("SIGINT", () => {
  console.log("\nProcess interrupted by user. Exiting.");
  process.exit(130);
});

main(process.argv[2]).catch(err => {
  console.error("A fatal error occurred:", err);
  process.exit(1);
});
