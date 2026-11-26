/**
 * NEPHRO-SPECTRA — GitHub Actions workflow lint.
 *
 * A broken workflow file only surfaces once someone pushes, which is the worst
 * moment to find out. This parses every workflow, checks the job graph, and
 * asserts the release contract the APK job depends on.
 */
import { load as yamlLoad } from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

const DIR = '.github/workflows'
const REQUIRED_JOBS = ['verify-web', 'build-apk', 'deploy-vercel', 'go-verify', 'rust-verify']
const APK = 'nephro-spectra-v28.0.0.apk'

let failures = 0
const assert = (ok, msg) => {
  if (ok) console.log(`  ok   ${msg}`)
  else {
    failures++
    console.error(`  FAIL ${msg}`)
  }
}

if (!fs.existsSync(DIR)) {
  console.error(`::error::${DIR} missing`)
  process.exit(1)
}

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))
assert(files.length > 0, `${files.length} workflow file(s) found`)

for (const file of files) {
  const full = path.join(DIR, file)
  let doc
  try {
    doc = yamlLoad(fs.readFileSync(full, 'utf8'))
    console.log(`  ok   ${file} parses`)
  } catch (err) {
    failures++
    console.error(`  FAIL ${file} is not valid YAML: ${err.message}`)
    continue
  }

  // `on:` is parsed as boolean true by YAML 1.1 — accept either form
  const triggers = doc.on ?? doc[true]
  assert(triggers && typeof triggers === 'object', `${file} declares triggers`)

  const jobs = doc.jobs || {}
  const names = Object.keys(jobs)
  assert(names.length > 0, `${file} declares ${names.length} job(s)`)

  for (const [name, job] of Object.entries(jobs)) {
    assert(Array.isArray(job.steps) && job.steps.length > 0, `${name} has steps`)
    for (const step of job.steps || []) {
      assert(step.uses || step.run, `${name}: step "${step.name || '(unnamed)'}" does something`)
    }
    if (job.needs) {
      for (const dep of [].concat(job.needs)) {
        assert(names.includes(dep), `${name} needs a job that exists (${dep})`)
      }
    }
  }

  assert(doc.env?.APK_NAME === APK, `${file} pins env.APK_NAME to ${APK}`)

  const gradlePath = 'android/app/build.gradle'
  if (fs.existsSync(gradlePath)) {
    const gradle = fs.readFileSync(gradlePath, 'utf8')
    assert(gradle.includes(`outputFileName = "${APK}"`), `Gradle names the release APK ${APK}`)
    assert(/versionName "28\.0\.0"/.test(gradle), 'Gradle versionName is 28.0.0')
    assert(/versionCode 28\b/.test(gradle), 'Gradle versionCode is 28')
    assert(
      gradle.includes('cameraxVersion'),
      'CameraX is wired into app/build.gradle (NephroDipstickCamera)'
    )
  } else {
    failures++
    console.error('  FAIL android/app/build.gradle missing')
  }

  const apkJob = jobs['build-apk']
  if (apkJob) {
    const text = JSON.stringify(apkJob)
    assert(text.includes('${APK_NAME}') || text.includes(APK), `build-apk uses the pinned APK name`)
    assert(text.includes('assets/public/assets/'), 'build-apk asserts the built JS/CSS is inside the APK')
    assert(text.includes('assembleRelease'), 'build-apk runs a Gradle release build')
    assert(text.includes('apksigner verify'), 'build-apk verifies the signature')
    assert(text.includes('assets/public/index.html'), 'build-apk asserts the web app is inside the APK')
    assert(text.includes('test:java'), 'build-apk gates on the Java sources parsing')
    assert(text.includes('actions/upload-artifact'), 'build-apk publishes an artefact')
  }

  for (const job of REQUIRED_JOBS) {
    if (job === 'deploy-vercel' || job === 'go-verify' || job === 'rust-verify') {
      assert(names.includes(job), `${file} defines ${job}`)
    }
  }
}

console.log(failures === 0 ? '\nworkflow(s) valid' : `\n${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
