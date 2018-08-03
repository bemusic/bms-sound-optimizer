const fs = require('fs')
const NotechartLoader = require('bemuse-notechart/lib/loader').NotechartLoader
const _ = require('lodash')
const path = require('path')
const args = require('minimist')(process.argv.slice(2), { string: ['_'] })
const log = require('pino')({ prettyPrint: true })
const glob = require('glob')
const { VError } = require('verror')

async function main() {
  try {
    const directory = args._[0]
    if (!directory) throw new Error('Must specify a source directory!')
    log.info({ directory }, 'bms-sound-optimizer is searching for files...')
    const files = glob.sync('*.{bms,bme,bml,bmson}', { cwd: directory })
    if (!files.length) throw new Error('No files found!')
    log.info({ files }, 'Notechart files found')
    const charts = await Promise.all(
      files.map(f => getNotes(path.join(directory, f)))
    )
    const soundsToPrerender = optimize(charts)
    if (!soundsToPrerender.length) {
      throw new Error('Cannot find sounds to prerender...')
    }
    if (args.f) {
      require('mkdirp').sync(path.join(directory, '_bgm_sounds'))
      for (const sound of soundsToPrerender) {
        fs.renameSync(
          path.join(directory, sound),
          path.join(directory, '_bgm_sounds', sound)
        )
      }
    } else {
      log.warn(
        'Dry-run mode. To actually move sound files, run again with `-f`.'
      )
    }
  } catch (e) {
    log.error(e)
    process.exitCode = 1
  }
}

/** @param {string} filePath */
async function getNotes(filePath) {
  const dirname = path.dirname(filePath)
  const buffer = fs.readFileSync(filePath)
  const loader = new NotechartLoader()
  const notechart = await loader.load(buffer, { name: filePath }, {})
  const notes = notechart.notes.concat(notechart.autos)

  const keys = {}
  const sounds = _
    .chain(notes)
    .filter(note => !note.keysoundStart)
    .map(note => {
      let keysound = note.keysound
      return {
        time: note.time,
        beat: note.beat,
        column: note.column,
        src: lookup(keysound),
        keysound: keysound
      }
    })
    .filter('src')
    .sortBy('time')
    .value()
  return { filePath, sounds }

  function lookup(k) {
    var result = keys[k] || (keys[k] = { result: find(k) })
    return result.result && path.relative(dirname, result.result)
  }

  function find(k) {
    var wav = notechart.keysounds[k.toLowerCase()]
    if (!wav) return null
    wav = path.resolve(filePath, '..', wav)
    if (fs.existsSync(wav)) return wav
    wav = wav.replace(/\.\w\w\w$/, '.wav')
    if (fs.existsSync(wav)) return wav
    wav = wav.replace(/\.\w\w\w$/, '.ogg')
    if (fs.existsSync(wav)) return wav
    wav = wav.replace(/\.\w\w\w$/, '.mp3')
    if (fs.existsSync(wav)) return wav
    return null
  }
}

function optimize(charts) {
  const allSounds = new Set()
  const bgmSounds = new Set()
  const keySounds = new Set()
  const eligibleStarters = []
  for (const chart of charts) {
    try {
      const occurrence = new Map()
      const firstNotes = new Set()
      let firstTime
      for (const sound of chart.sounds) {
        allSounds.add(sound.src)
        if (sound.column) {
          keySounds.add(sound.src)
        } else {
          bgmSounds.add(sound.src)
        }
        occurrence.set(sound.src, (occurrence.get(sound.src) || 0) + 1)
        if (firstTime == null) {
          firstTime = sound.time
        }
        if (sound.time === firstTime) {
          firstNotes.add(sound.src)
        }
      }
      const oneOffs = new Set(
        [...occurrence.entries()].filter(([, v]) => v === 1).map(([k, v]) => k)
      )
      const starters = new Set(
        [...firstNotes].filter(src => oneOffs.has(src) && bgmSounds.has(src))
      )
      if (!starters.size) {
        throw new Error(
          'No suitable starter sounds found. A starter sound must be a BGM, used once, and come before any other sound.'
        )
      }
      eligibleStarters.push(starters)
      log.info({ starters: [...starters] }, 'Processed', chart.filePath)
    } catch (e) {
      throw new VError(e, 'Error while process "%s"', chart.filePath)
    }
  }
  const usableStarters = eligibleStarters.reduce(
    (remaining, starters) =>
      new Set([...remaining].filter(s => starters.has(s)))
  )
  if (!usableStarters.size) {
    throw new Error('Cannot find a common suitable starter sound.')
  }
  log.info(
    { usableStarters: [...usableStarters] },
    'Usable starter sound computed'
  )
  const soundsToRender = [...allSounds].filter(
    s => bgmSounds.has(s) && !keySounds.has(s)
  )
  log.info({ soundsToRender }, `Can pre-render ${soundsToRender.length} sounds`)
  return soundsToRender
}

process.on('unhandledRejection', up => {
  throw up
})
main()
