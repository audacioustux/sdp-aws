import { getProject, getOrganization, getStack, Config } from '@pulumi/pulumi'

const pulumiConfig = new Config()
const pulumi = {
  organization: getOrganization(),
  project: getProject(),
  stack: getStack(),
  namespace: pulumiConfig.require('namespace').toLowerCase(),
}

const gitConfig = new Config('git')
const git = {
  repo: gitConfig.require('repo'),
  path: gitConfig.require('path'),
  username: gitConfig.require('username'),
  password: gitConfig.requireSecret('password'),
}

const defaults = {
  pod: {
    resources: {
      requests: {
        cpu: '20m',
        memory: '64Mi',
      },
      limits: {
        memory: '256Mi',
      },
    },
  },
}

const grafanaConfig = new Config('grafana')
const grafana = {
  host: grafanaConfig.require('host'),
}

const argocdConfig = new Config('argocd')
const argocd = {
  host: argocdConfig.require('host'),
}

const adminConfig = new Config('admin')
const admin = {
  email: adminConfig.require('email'),
}

const route53Config = new Config('route53')
const route53 = {
  zones: route53Config.requireObject<string[]>('zones'),
  region: route53Config.require('region'),
}

const zerosslConfig = new Config('zerossl')
const zerossl = {
  keyId: zerosslConfig.require('kid'),
  hmac: zerosslConfig.requireSecret('hmac'),
}

// TODO: move hard-coded configs in index.ts to here

export { git, pulumi, grafana, defaults, argocd, admin, route53, zerossl }
