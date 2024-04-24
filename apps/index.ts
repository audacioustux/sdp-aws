import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import { registerAutoTags } from './utils/autotag.ts'
import * as config from './config.ts'
import { objectToYaml } from './utils/yaml.ts'
import { assumeRoleForEKSPodIdentity } from './utils/policyStatement.ts'
import Application from './crds/applications/argoproj/v1alpha1/application.ts'
import AppProject from './crds/appprojects/argoproj/v1alpha1/appProject.ts'
const argocd = {
  ...Application,
  ...AppProject,
}

// Automatically inject tags.
registerAutoTags({
  'pulumi:Organization': config.pulumi.organization,
  'pulumi:Project': config.pulumi.project,
  'pulumi:Stack': config.pulumi.stack,
})

const nm = (name: string) => `${config.pulumi.project}-${config.pulumi.stack}-${name}`
