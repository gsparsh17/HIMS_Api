const fs = require("fs");
const path = require("path");

const projectRoot = process.cwd();

const includedFolders = [
    "config",
    "controllers",
    "jobs",
    "middlewares",
    "models",
    "routes",
    "scripts",
    "services",
    "utils"
];

const rootFiles = [
    ".env",
    ".gitignore",
    "app.js",
    "server.js",
    "server2.js",
    "package.json",
    "README.md"
];

const ignoredFolders = [
    "node_modules",
    "uploads",
    ".git"
];

const ignoredFiles = [
    "package-lock.json",
    "token.json",
    "oauth-credentials.json",
    "models.zip"
];

const allowedExtensions = [
    ".js",
    ".json",
    ".env",
    ".md",
    ".txt"
];

const outputFile = "project_export.txt";

let output = "";

function addFile(filePath) {
    try {
        const ext = path.extname(filePath).toLowerCase();

        if (
            allowedExtensions.includes(ext) ||
            path.basename(filePath).startsWith(".")
        ) {
            const content = fs.readFileSync(filePath, "utf8");

            output += `
================================================================================
FILE: ${path.relative(projectRoot, filePath)}
================================================================================

${content}

`;
        }
    } catch (err) {
        console.error(`Failed: ${filePath}`);
    }
}

function scanDirectory(dir) {
    if (!fs.existsSync(dir)) return;

    const items = fs.readdirSync(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);

        if (ignoredFiles.includes(item)) continue;

        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (ignoredFolders.includes(item)) continue;
            scanDirectory(fullPath);
        } else {
            addFile(fullPath);
        }
    }
}

try {
    console.log("Exporting project...");

    for (const file of rootFiles) {
        const filePath = path.join(projectRoot, file);

        if (fs.existsSync(filePath)) {
            addFile(filePath);
        }
    }

    for (const folder of includedFolders) {
        const folderPath = path.join(projectRoot, folder);

        output += `

################################################################################
FOLDER: ${folder}
################################################################################

`;

        scanDirectory(folderPath);
    }

    fs.writeFileSync(outputFile, output, "utf8");

    console.log(`\n✅ Export completed`);
    console.log(`📄 ${path.resolve(outputFile)}`);
    console.log(`📊 Size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(2)} MB`);
} catch (err) {
    console.error(err);
}