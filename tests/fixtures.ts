import { Local } from 'browserstack-local'

let server

export function mochaGlobalSetup(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = new Local()
    server.start({
      'key': process.env.BROWSERSTACK_ACCESS_KEY
    }, (err) => {
      if (err) {
          reject(err)
      } else {
          resolve()
      }
    })
  })
}

export async function mochaGlobalTeardown(): Promise<void> {
  return new Promise(resolve => {
    server.stop(() => {
      resolve()
    })
    server = null
  })
}