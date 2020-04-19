#!/usr/bin/env node

import puppeteer = require('puppeteer')
import prompt = require('async-prompt')
import program = require('commander')
import { of, from, Observable } from 'rxjs'

import { toArray, mergeMap, flatMap, tap, shareReplay, filter } from 'rxjs/operators'
import { retryBackoff } from "backoff-rxjs"

import { Configuration, Downloader } from "./Core"
import { EdxDownloader } from "./EdxDownloader"


function clone(object: any, overwtite: any = {}) {
  return Object.assign(Object.assign({}, object), overwtite)
}

function parseFormat(value: string, _: string) {
  if (!["pdf", "png"].includes(value)) {
    console.log(`invalid format: ${value}`)
    process.exit(1)
  }
  return value
}

async function getConfiguration(): Promise<Configuration> {
  const courseUrlPattern = /^https:\/\/courses.edx.org\/courses\/.*\/course\/$/
  function parseInteger(v: string) { return parseInt(v) }

  program
    .name("edx-archive")
    .arguments('<course_url>')
    .option('-u, --user <email>', 'edx login (email)')
    .option('-p, --password <password>', 'edx password')
    .option('-o, --output <directory>', 'output directory', 'Archive')
    .option('-f, --format <format>', 'save pages as pdf or png', parseFormat, 'pdf')
    .option('-r, --retries <retries>', 'number of retry attempts in case of failure', parseInteger, 3)
    .option('-d, --delay <seconds>', 'delay before saving page', parseInteger, 1)
    .option('-c, --concurrency <number>', 'number of pages to save in parallel', parseInteger, 4)
    .option('--debug', 'output extra debugging', false)
    .parse(process.argv)

  if (program.args.length !== 1) {
    program.help()
  }

  if (!program.args[0].match(courseUrlPattern)) {
    console.log("Invalid course url.\nCourse url should look like: https://courses.edx.org/<course_id>/course/")
    process.exit(1)
  }

  const configuration = clone(program.opts())

  configuration.courseUrl = program.args[0]

  if (!configuration.user) {
    configuration.user = await prompt('User: ')
  }

  if (!configuration.password) {
    configuration.password = await prompt.password('Password: ')
  }

  return configuration
}

async function main() {
  const kickstart = of(null as void)
  var browser: puppeteer.Browser

  try {
    // build configuration
    const configuration = await getConfiguration()
    if (configuration.debug) {
      console.log("Configuration:")
      console.log(clone(configuration, { user: "<censored>", password: "<censored>" }))
    }
    const backoffConfig = {
      initialInterval: 5000,
      maxInterval: 60000,
      maxRetries: configuration.retries,
    }

    // init helper for logging\debug info
    function trace<T>(
      logFunction: (v: T) => void,
      extraLogFunction: (v: T) => void = v => console.log(v)
    ) {
      return (source: Observable<T>) => source.pipe(
        tap(v => { logFunction(v); if (configuration.debug) extraLogFunction(v) })
      )
    }

    // prepare downloader
    browser = await puppeteer.launch()
    const downloader = new EdxDownloader(configuration, browser) as Downloader

    // // login
    await kickstart.pipe(
      tap(() => console.log("Logging in...")),
      shareReplay(),
      flatMap(downloader.login),
      tap(() => console.log("Logged in.")),
      retryBackoff(backoffConfig),
    ).toPromise()

    // getting download tasks
    const tasks = await kickstart.pipe(
      tap(() => console.log("Getting download tasks...")),
      shareReplay(),
      flatMap(downloader.getDownloadTasks),
      trace(() => {}, task => { console.log("Created download task:"); console.log(task) }),
      // TODO filter and distinct here
      toArray(),
      trace(tasks => console.log(`Scheduled ${tasks.length} download tasks.`)),
      retryBackoff(backoffConfig),
    ).toPromise()

    // perform downloads
    const results = await kickstart.pipe(
      tap(() => console.log("Downloading...")),
      flatMap(() => from(tasks)),
      shareReplay(),
      mergeMap(
        task => of(task).pipe(
          trace(task => console.log(`Downloading task: ${task.name}`)),
          shareReplay(),
          flatMap(downloader.performDownload),
          trace(result => console.log(`Download complete: ${result.task.name}`)),
          retryBackoff(backoffConfig),
        ),
        configuration.concurrency
      ),
      toArray(),
    ).toPromise()

    // output report
    downloader.reportResults(results)

    // shutdown
    await browser.close()
    console.log("Done.")
  } catch (e) {
    console.error(e)
    browser?.close()
    process.exit(1)
  }
}

main()
