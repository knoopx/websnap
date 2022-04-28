const fs = require("fs")
const path = require("path")

const yargs = require("yargs")
const portfinder = require("portfinder")
const puppeteer = require("puppeteer")
const glob = require("fast-glob")
const { createServer } = require("http-server")
const { Cluster } = require("puppeteer-cluster")

const CONCURRENCY_MODE = Cluster.CONCURRENCY_PAGE

const EMULATE = {
  desktop: {
    name: "Desktop",
    userAgent:
      "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Mobile Safari/537.36",
    viewport: {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
    },
  },
  tablet: puppeteer.devices.iPad,
  mobile: puppeteer.devices["Pixel 5"],
}

async function snapshot(page, url, baseName, { device, extension, media }) {
  await page.emulate(device.config)
  await page._client.send("Emulation.setEmulatedMedia", {
    media,
  })

  await page.goto(url, {
    waitUntil: "networkidle2",
  })

  const outputPath = `${baseName}-${device.alias}${extension}`
  console.log(
    `Capturing ${new URL(url).pathname} (${device.alias}) -> ${outputPath}`,
  )
  await page.screenshot({
    path: outputPath,
    fullPage: true,
  })
}

async function start({
  baseUrl,
  pages: files,
  outputPath,
  extension,
  maxConcurrency,
  media,
}) {
  const cluster = await Cluster.launch({
    puppeteerOptions: {
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
      ],
    },
    concurrency: CONCURRENCY_MODE,
    maxConcurrency,
  })

  await cluster.task(async ({ page, data: { file, url, device } }) => {
    const basename = path.basename(file, path.extname(file))
    const targetPath = path.join(outputPath, path.dirname(file))
    const targetName = path.join(targetPath, basename)
    fs.mkdirSync(targetPath, { recursive: true })

    try {
      await snapshot(page, url, targetName, { device, extension, media })
    } catch (error) {
      console.error(`${file} (${device.alias}) -> ${error}`)
    }
  })

  files.forEach(async (file) => {
    for (const [alias, config] of Object.entries(EMULATE)) {
      cluster.queue({
        file,
        url: `${baseUrl}/${file}`,
        device: { alias, config },
      })
    }
  })

  await cluster.idle()
  await cluster.close()
}

function run({
  www: root,
  output: outputPath,
  basePort,
  extension,
  maxConcurrency,
  media,
}) {
  const pages = glob.sync("**/*.html", { cwd: root })
  if (!pages.length) {
    throw new Error(`No HTML pages found at ${root}`)
  }
  portfinder.basePort = basePort
  portfinder.getPort((err, port) => {
    if (err) {
      throw err
    }

    const server = createServer({ root })
    server.listen(port, async () => {
      const baseUrl = `http://localhost:${port}`
      console.log(`Started local server at ${baseUrl}`)
      await start({
        baseUrl,
        pages,
        outputPath: path.resolve(outputPath),
        maxConcurrency,
        extension,
        media,
      })
      server.close()
    })
  })
}

process.on("unhandledRejection", (error) => {
  console.log("unhandled rejection", error.message)
})

const { argv } = yargs
  .scriptName("websnap")
  .usage("$0 [options] --www <www-dir> --output <output-dir>")
  .option("www", {
    alias: "w",
  })
  .option("output", {
    alias: "o",
  })
  .option("maxConcurrency", {
    alias: "N",
    default: 4,
  })
  .option("basePort", {
    alias: "P",
    default: 8080,
  })
  .option("extension", {
    alias: "e",
    default: ".png",
  })
  .option("media", {
    alias: "m",
    default: "websnap",
  })
  .demandOption(["www", "output"])
  .help()

run(argv)
