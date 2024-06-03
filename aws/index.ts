import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import { registerAutoTags } from './utils/autotag.ts'
import * as config from './config.ts'
import { assumeRoleForEKSPodIdentity } from './utils/policyStatement.ts'
import { request } from 'http'

// Automatically inject tags.
registerAutoTags({
  'pulumi:Organization': config.pulumi.organization,
  'pulumi:Project': config.pulumi.project,
  'pulumi:Stack': config.pulumi.stack,
})

const nm = (name: string) => `${config.pulumi.project}-${config.pulumi.stack}-${name}`
const nmo = (name: string) => `${nm(name)}-${config.pulumi.organization}`

// === VPC ===

const vpcName = nm('vpc')
const vpc = new aws.ec2.Vpc(vpcName, {
  cidrBlock: '10.0.0.0/16',
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: {
    Name: vpcName,
  },
})

// === VPC === Subnets ===

const availabilityZones = await aws.getAvailabilityZones({
  state: 'available',
})
const publicSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = nm(`public-${index}`)
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: true,
    tags: {
      Name: subnetName,
    },
  })
})
const privateSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = nm(`private-${index}`)
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index + 10}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: false,
    tags: {
      Name: subnetName,
    },
  })
})

// === VPC === Internet Gateway ===

const internetGatewayName = nm('igw')
const internetGateway = new aws.ec2.InternetGateway(internetGatewayName, {
  vpcId: vpc.id,
  tags: {
    Name: internetGatewayName,
  },
})

// === VPC === NAT Gateway ===

const eipName = nm('eip')
const eip = new aws.ec2.Eip(eipName, {
  domain: 'vpc',
  tags: {
    Name: eipName,
  },
})

const natGatewayName = nm('nat')
const natGateway = new aws.ec2.NatGateway(natGatewayName, {
  subnetId: publicSubnets[0].id,
  allocationId: eip.id,
  connectivityType: 'public',
  tags: {
    Name: natGatewayName,
  },
})

// === VPC === Route Tables ===

const publicRouteTableName = nm('public')
const publicRouteTable = new aws.ec2.RouteTable(publicRouteTableName, {
  vpcId: vpc.id,
  tags: {
    Name: publicRouteTableName,
  },
})
new aws.ec2.Route(nm('to-igw'), {
  routeTableId: publicRouteTable.id,
  destinationCidrBlock: '0.0.0.0/0',
  gatewayId: internetGateway.id,
})
publicSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(
    `public-assoc-${index}`,
    {
      routeTableId: publicRouteTable.id,
      subnetId: subnet.id,
    },
    { parent: publicRouteTable },
  )
})

const privateRouteTableName = nm('private')
const privateRouteTable = new aws.ec2.RouteTable(privateRouteTableName, {
  vpcId: vpc.id,
  tags: {
    Name: privateRouteTableName,
  },
})
new aws.ec2.Route(nm('to-nat'), {
  routeTableId: privateRouteTable.id,
  destinationCidrBlock: '0.0.0.0/0',
  natGatewayId: natGateway.id,
})
privateSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(
    `private-assoc-${index}`,
    {
      routeTableId: privateRouteTable.id,
      subnetId: subnet.id,
    },
    { parent: privateRouteTable },
  )
})

// === KMS ===

const kmsKeyName = nm('kms')
const kmsKey = new aws.kms.Key(kmsKeyName, {
  bypassPolicyLockoutSafetyCheck: false,
  enableKeyRotation: true,
  deletionWindowInDays: 30,
})
new aws.kms.Alias(kmsKeyName, {
  name: `alias/${kmsKeyName}`,
  targetKeyId: kmsKey.id,
})

// === EKS === Cluster ===

const eksInstanceRole = new aws.iam.Role(nm('eks-instance-role'), {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
    'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
    'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  ],
})

const eksClusterName = nm('eks')
const {
  eksCluster,
  core: cluster,
  kubeconfig,
  provider,
} = new eks.Cluster(eksClusterName, {
  name: eksClusterName,
  version: '1.30',
  vpcId: vpc.id,
  createOidcProvider: true,
  publicSubnetIds: publicSubnets.map((s) => s.id),
  privateSubnetIds: privateSubnets.map((s) => s.id),
  nodeAssociatePublicIpAddress: false,
  encryptionConfigKeyArn: kmsKey.arn,
  defaultAddonsToRemove: ['kube-proxy', 'vpc-cni', 'coredns'],
  useDefaultVpcCni: true,
  // TODO: disable public access to the cluster (use vpc client endpoint instead)
  // endpointPublicAccess: false,
  skipDefaultNodeGroup: true,
  instanceRole: eksInstanceRole,
})

const clusterSecurityGroupId = eksCluster.vpcConfig.clusterSecurityGroupId

// === EKS === Node Group ===

const defaultNodeGroupName = nm('default')
new eks.ManagedNodeGroup(defaultNodeGroupName, {
  cluster,
  nodeGroupName: defaultNodeGroupName,
  instanceTypes: ['m7g.large', 'm7gd.large', 't4g.large'],
  capacityType: 'SPOT',
  // amiType: 'BOTTLEROCKET_ARM_64',
  amiType: 'AL2023_ARM_64_STANDARD',
  nodeRole: cluster.instanceRoles[0],
  taints: [
    {
      key: 'node.cilium.io/agent-not-ready',
      value: 'true',
      effect: 'NO_EXECUTE',
    },
  ],
})

// === EKS === Cilium ===

new k8s.helm.v3.Release(
  nm('cilium'),
  {
    name: 'cilium',
    chart: 'cilium',
    namespace: 'kube-system',
    version: '1.15.5',
    repositoryOpts: {
      repo: 'https://helm.cilium.io',
    },
    values: {
      rollOutCiliumPods: true,
      kubeProxyReplacement: 'strict',
      k8sServiceHost: cluster.endpoint.apply((endpoint) => endpoint.replace('https://', '')),
      resources: {
        requests: {
          cpu: '0.2',
          memory: '256Mi',
        },
        limits: {
          memory: '512Mi',
        },
      },
      ingressController: {
        enabled: true,
        loadbalancerMode: 'shared',
        default: true,
        service: {
          annotations: {
            'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
          },
        },
      },
      hubble: {
        relay: {
          rollOutPods: true,
          enabled: true,
          resources: config.defaults.pod.resources,
        },
        ui: {
          rollOutPods: true,
          enabled: true,
          frontend: {
            resources: config.defaults.pod.resources,
          },
        },
      },
      operator: {
        rollOutPods: true,
        resources: config.defaults.pod.resources,
      },
      loadBalancer: {
        algorithm: 'maglev',
        mode: 'hybrid',
        acceleration: 'best-effort',
        l7: {
          backend: 'envoy',
        },
      },
      envoy: {
        rollOutPods: true,
        enabled: true,
        resources: config.defaults.pod.resources,
      },
      routingMode: 'native',
      bpf: {
        masquerade: true,
        // NOTE: https://github.com/cilium/cilium/issues/20942
        // https://github.com/cilium/cilium/issues/20677
        // hostLegacyRouting: true,
      },
      ipam: {
        mode: 'eni',
      },
      eni: {
        enabled: true,
        awsEnablePrefixDelegation: true,
      },
    },
  },
  { provider },
)

// TODO: Move Addons to Helm Releases
// NOTE: EKS Addons are not as flexible/configurable as Helm Charts. e.g. https://github.com/kubernetes-sigs/aws-efs-csi-driver/issues/1181

// === EKS === Addons === CoreDNS ===

new aws.eks.Addon(nm('coredns'), {
  addonName: 'coredns',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply((version) =>
    aws.eks.getAddonVersion({
      addonName: 'coredns',
      kubernetesVersion: version,
      mostRecent: true,
    }),
  ).version,
  resolveConflictsOnUpdate: 'OVERWRITE',
  configurationValues: JSON.stringify({
    resources: config.defaults.pod.resources,
  }),
})

// === EKS === Addons === Pod Identity Agent ===

new aws.eks.Addon(nm('pod-identity-agent'), {
  addonName: 'eks-pod-identity-agent',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'eks-pod-identity-agent',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  resolveConflictsOnUpdate: 'OVERWRITE',
  configurationValues: JSON.stringify({
    resources: config.defaults.pod.resources,
  }),
})

// === EKS === Addons === EBS CSI Driver ===

const ebsCsiDriverRoleName = nm('ebs-csi-driver-irsa')
const ebsCsiDriverRole = new aws.iam.Role(ebsCsiDriverRoleName, {
  assumeRolePolicy: pulumi.all([cluster.oidcProvider?.url, cluster.oidcProvider?.arn]).apply(([url, arn]) => {
    if (!url || !arn) throw new Error('OIDC provider URL or ARN is undefined')

    return aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          effect: 'Allow',
          actions: ['sts:AssumeRoleWithWebIdentity'],
          principals: [
            {
              type: 'Federated',
              identifiers: [arn],
            },
          ],
          conditions: [
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:sub`,
              values: ['system:serviceaccount:kube-system:ebs-csi-controller-sa'],
            },
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:aud`,
              values: ['sts.amazonaws.com'],
            },
          ],
        },
      ],
    })
  }).json,
})
new aws.iam.RolePolicyAttachment(`${ebsCsiDriverRoleName}-attachment`, {
  role: ebsCsiDriverRole,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy',
})
new aws.eks.Addon(nm('ebs-csi-driver'), {
  addonName: 'aws-ebs-csi-driver',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'aws-ebs-csi-driver',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  serviceAccountRoleArn: ebsCsiDriverRole.arn,
  resolveConflictsOnUpdate: 'OVERWRITE',
})

// === EKS === Addons === EFS CSI Driver ===

const efsCsiDriverRoleName = nm('efs-csi-driver-irsa')
const efsCsiDriverRole = new aws.iam.Role(efsCsiDriverRoleName, {
  assumeRolePolicy: pulumi.all([cluster.oidcProvider?.url, cluster.oidcProvider?.arn]).apply(([url, arn]) => {
    if (!url || !arn) throw new Error('OIDC provider URL or ARN is undefined')

    return aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          effect: 'Allow',
          actions: ['sts:AssumeRoleWithWebIdentity'],
          principals: [
            {
              type: 'Federated',
              identifiers: [arn],
            },
          ],
          conditions: [
            {
              test: 'StringLike',
              variable: `${url.replace('https://', '')}:sub`,
              values: ['system:serviceaccount:kube-system:efs-csi-*'],
            },
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:aud`,
              values: ['sts.amazonaws.com'],
            },
          ],
        },
      ],
    })
  }).json,
})
new aws.iam.RolePolicyAttachment(`${efsCsiDriverRoleName}-attachment`, {
  role: efsCsiDriverRole,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEFSCSIDriverPolicy',
})
new aws.eks.Addon(nm('efs-csi-driver'), {
  addonName: 'aws-efs-csi-driver',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'aws-efs-csi-driver',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  serviceAccountRoleArn: efsCsiDriverRole.arn,
  resolveConflictsOnUpdate: 'OVERWRITE',
  // TODO: add resource requirements
})

// === EKS === Addons === S3 Mountpoint Driver ===

const s3MountpointDriverRoleName = nm('s3-mountpoint-driver-irsa')
const s3MountpointDriverRole = new aws.iam.Role(s3MountpointDriverRoleName, {
  assumeRolePolicy: pulumi.all([cluster.oidcProvider?.url, cluster.oidcProvider?.arn]).apply(([url, arn]) => {
    if (!url || !arn) throw new Error('OIDC provider URL or ARN is undefined')

    return aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          effect: 'Allow',
          actions: ['sts:AssumeRoleWithWebIdentity'],
          principals: [
            {
              type: 'Federated',
              identifiers: [arn],
            },
          ],
          conditions: [
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:sub`,
              values: ['system:serviceaccount:kube-system:s3-csi-driver-sa'],
            },
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:aud`,
              values: ['sts.amazonaws.com'],
            },
          ],
        },
      ],
    })
  }).json,
})
new aws.iam.RolePolicyAttachment(`${s3MountpointDriverRoleName}-attachment`, {
  role: s3MountpointDriverRole,
  policyArn: aws.iam.ManagedPolicies.AmazonS3FullAccess,
})
new aws.eks.Addon(nm('s3-mountpoint-driver'), {
  addonName: 'aws-mountpoint-s3-csi-driver',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'aws-mountpoint-s3-csi-driver',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  serviceAccountRoleArn: s3MountpointDriverRole.arn,
  resolveConflictsOnUpdate: 'OVERWRITE',
})

// === EC2 === Interruption Queue ===

const EC2InterruptionQueueName = nm('ec2-interruption-queue')
const EC2InterruptionQueue = new aws.sqs.Queue(EC2InterruptionQueueName, {
  messageRetentionSeconds: 300,
  sqsManagedSseEnabled: true,
})
const EC2InterruptionQueuePolicyName = `${EC2InterruptionQueueName}-policy`
new aws.sqs.QueuePolicy(EC2InterruptionQueuePolicyName, {
  queueUrl: EC2InterruptionQueue.id,
  policy: {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Service: ['events.amazonaws.com', 'sqs.amazonaws.com'],
        },
        Action: 'sqs:SendMessage',
        Resource: EC2InterruptionQueue.arn,
      },
    ],
  },
})

const scheduledChangeRuleName = nm('scheduled-change-rule')
const scheduledChangeRule = new aws.cloudwatch.EventRule(scheduledChangeRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.health'],
    'detail-type': ['AWS Health Event'],
  }),
})
new aws.cloudwatch.EventTarget(scheduledChangeRuleName, {
  rule: scheduledChangeRule.name,
  arn: EC2InterruptionQueue.arn,
})

const spotInterruptionRuleName = nm('spot-interruption-rule')
const spotInterruptionRule = new aws.cloudwatch.EventRule(spotInterruptionRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Spot Instance Interruption Warning'],
  }),
})
new aws.cloudwatch.EventTarget(spotInterruptionRuleName, {
  rule: spotInterruptionRule.name,
  arn: EC2InterruptionQueue.arn,
})

const rebalanceRuleName = nm('rebalance-rule')
const rebalanceRule = new aws.cloudwatch.EventRule(rebalanceRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance Rebalance Recommendation'],
  }),
})
new aws.cloudwatch.EventTarget(rebalanceRuleName, {
  rule: rebalanceRule.name,
  arn: EC2InterruptionQueue.arn,
})

const instanceStateChangeRuleName = nm('instance-state-change-rule')
const instanceStateChangeRule = new aws.cloudwatch.EventRule(instanceStateChangeRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance State-change Notification'],
  }),
})
new aws.cloudwatch.EventTarget(instanceStateChangeRuleName, {
  rule: instanceStateChangeRule.name,
  arn: EC2InterruptionQueue.arn,
})

// === EKS === Karpenter === Controller Role ===

interface KarpenterControllerPolicyProps {
  partitionId: string
  regionId: string
  accountId: string
  eksClusterName: string
  eksNodeRoleName: string
  ec2InterruptionQueueName: string
}

const karpenterControllerPolicy = ({
  partitionId,
  regionId,
  accountId,
  eksClusterName,
  eksNodeRoleName,
  ec2InterruptionQueueName,
}: KarpenterControllerPolicyProps) =>
  aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: 'AllowScopedEC2InstanceAccessActions',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}::image/*`,
          `arn:${partitionId}:ec2:${regionId}::snapshot/*`,
          `arn:${partitionId}:ec2:${regionId}:*:security-group/*`,
          `arn:${partitionId}:ec2:${regionId}:*:subnet/*`,
        ],
        actions: ['ec2:RunInstances', 'ec2:CreateFleet'],
      },
      {
        sid: 'AllowScopedEC2LaunchTemplateAccessActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ec2:${regionId}:*:launch-template/*`],
        actions: ['ec2:RunInstances', 'ec2:CreateFleet'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedEC2InstanceActionsWithTags',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}:*:fleet/*`,
          `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
          `arn:${partitionId}:ec2:${regionId}:*:volume/*`,
          `arn:${partitionId}:ec2:${regionId}:*:network-interface/*`,
          `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
          `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`,
        ],
        actions: ['ec2:RunInstances', 'ec2:CreateFleet', 'ec2:CreateLaunchTemplate'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedResourceCreationTagging',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}:*:fleet/*`,
          `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
          `arn:${partitionId}:ec2:${regionId}:*:volume/*`,
          `arn:${partitionId}:ec2:${regionId}:*:network-interface/*`,
          `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
          `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`,
        ],
        actions: ['ec2:CreateTags'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'ec2:CreateAction',
            values: ['RunInstances', 'CreateFleet', 'CreateLaunchTemplate'],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedResourceTagging',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ec2:${regionId}:*:instance/*`],
        actions: ['ec2:CreateTags'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*'],
          },
          {
            test: 'ForAllValues:StringEquals',
            variable: 'aws:TagKeys',
            values: ['karpenter.sh/nodeclaim', 'Name'],
          },
        ],
      },
      {
        sid: 'AllowScopedDeletion',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
          `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
        ],
        actions: ['ec2:TerminateInstances', 'ec2:DeleteLaunchTemplate'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowRegionalReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: [
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeImages',
          'ec2:DescribeInstances',
          'ec2:DescribeInstanceTypeOfferings',
          'ec2:DescribeInstanceTypes',
          'ec2:DescribeLaunchTemplates',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeSpotPriceHistory',
          'ec2:DescribeSubnets',
        ],
        conditions: [
          {
            test: 'StringEquals',
            variable: 'aws:RequestedRegion',
            values: [regionId],
          },
        ],
      },
      {
        sid: 'AllowSSMReadActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ssm:${regionId}::parameter/aws/service/*`],
        actions: ['ssm:GetParameter'],
      },
      {
        sid: 'AllowPricingReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['pricing:GetProducts'],
      },
      {
        sid: 'AllowInterruptionQueueActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:sqs:${regionId}:${accountId}:${ec2InterruptionQueueName}`],
        actions: ['sqs:DeleteMessage', 'sqs:GetQueueUrl', 'sqs:ReceiveMessage'],
      },
      {
        sid: 'AllowPassingInstanceRole',
        effect: 'Allow',
        resources: [`arn:${partitionId}:iam::${accountId}:role/${eksNodeRoleName}`],
        actions: ['iam:PassRole'],
        conditions: [
          {
            test: 'StringEquals',
            variable: 'iam:PassedToService',
            values: ['ec2.amazonaws.com'],
          },
        ],
      },
      {
        sid: 'AllowScopedInstanceProfileCreationActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:CreateInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:RequestTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedInstanceProfileTagActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:TagInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:ResourceTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:RequestTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedInstanceProfileActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile', 'iam:DeleteInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:ResourceTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowInstanceProfileReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:GetInstanceProfile'],
      },
      {
        sid: 'AllowAPIServerEndpointDiscovery',
        effect: 'Allow',
        resources: [`arn:${partitionId}:eks:${regionId}:${accountId}:cluster/${eksClusterName}`],
        actions: ['eks:DescribeCluster'],
      },
    ],
  })

const partitionId = await aws.getPartition().then((partition) => partition.id)
const regionId = await aws.getRegion().then((region) => region.id)
const accountId = await aws.getCallerIdentity().then((identity) => identity.accountId)

const karpenterControllerPolicyName = nm('karpenter-controller-policy')
const KarpenterControllerPolicy = new aws.iam.Policy(karpenterControllerPolicyName, {
  policy: pulumi.all([eksCluster.name, EC2InterruptionQueue.name, eksInstanceRole.name]).apply(
    ([eksClusterName, ec2InterruptionQueueName, eksNodeRoleName]) =>
      karpenterControllerPolicy({
        partitionId,
        regionId,
        accountId,
        eksClusterName: eksClusterName,
        eksNodeRoleName,
        ec2InterruptionQueueName,
      }).json,
  ),
})
const karpenterControllerRoleName = nm('karpenter-controller-role')
const karpenterControllerRole = new aws.iam.Role(karpenterControllerRoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
new aws.iam.RolePolicyAttachment(karpenterControllerRoleName, {
  policyArn: KarpenterControllerPolicy.arn,
  role: karpenterControllerRole,
})
new aws.eks.PodIdentityAssociation(nm('karpenter-controller-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: 'kube-system',
  serviceAccount: 'karpenter',
  roleArn: karpenterControllerRole.arn,
})

// === EKS === Karpenter ===

const karpenterCRD = new k8s.helm.v3.Release(
  nm('karpenter-crd'),
  {
    name: 'karpenter-crd',
    chart: 'oci://public.ecr.aws/karpenter/karpenter-crd',
    namespace: 'kube-system',
    version: '0.37.0',
  },
  { provider },
)

const karpenter = new k8s.helm.v3.Release(
  nm('karpenter'),
  {
    name: 'karpenter',
    chart: 'oci://public.ecr.aws/karpenter/karpenter',
    namespace: karpenterCRD.namespace,
    version: karpenterCRD.version,
    values: {
      settings: {
        clusterName: eksCluster.name,
        interruptionQueue: EC2InterruptionQueue.name,
        featureGates: {
          spotToSpotConsolidation: true,
        },
      },
      serviceMonitor: {
        enabled: true,
      },
      controller: {
        resources: {
          requests: {
            memory: '256Mi',
          },
          limits: {
            memory: '512Mi',
          },
        },
      },
    },
    timeout: 60 * 30,
  },
  { provider },
)

// === EKS === Karpenter === Node Class ===

const defaultNodeClass = new k8s.apiextensions.CustomResource(
  nm('default-node-class'),
  {
    apiVersion: 'karpenter.k8s.aws/v1beta1',
    kind: 'EC2NodeClass',
    metadata: {
      name: 'default',
    },
    spec: {
      // amiFamily: 'Bottlerocket',
      amiFamily: 'AL2023',
      role: eksInstanceRole.name,
      associatePublicIPAddress: false,
      subnetSelectorTerms: privateSubnets.map(({ id }) => ({ id })),
      securityGroupSelectorTerms: [
        {
          id: clusterSecurityGroupId,
        },
      ],
    },
  },
  { provider, dependsOn: [karpenter] },
)

// === EKS === Karpenter === Node Pool ===

new k8s.apiextensions.CustomResource(
  nm('default-node-pool'),
  {
    apiVersion: 'karpenter.sh/v1beta1',
    kind: 'NodePool',
    metadata: {
      name: 'default',
    },
    spec: {
      template: {
        spec: {
          requirements: [
            {
              key: 'kubernetes.io/arch',
              operator: 'In',
              values: ['arm64'],
            },
            {
              key: 'kubernetes.io/os',
              operator: 'In',
              values: ['linux'],
            },
            {
              key: 'karpenter.sh/capacity-type',
              operator: 'In',
              values: ['spot', 'on-demand'],
            },
          ],
          nodeClassRef: {
            apiVersion: 'karpenter.k8s.aws/v1beta1',
            kind: 'EC2NodeClass',
            name: defaultNodeClass.metadata.name,
          },
          // NOTE: https://github.com/bottlerocket-os/bottlerocket/issues/1721
          kubelet: {
            podsPerCore: 20,
            maxPods: 110,
          },
          startupTaints: [
            {
              key: 'node.cilium.io/agent-not-ready',
              value: 'true',
              effect: 'NoExecute',
            },
          ],
        },
      },
      limits: {
        cpu: '16',
        memory: '48Gi',
      },
      disruption: {
        consolidationPolicy: 'WhenUnderutilized',
        expireAfter: `${24 * 30}h`,
      },
    },
  },
  { provider, dependsOn: [karpenter] },
)

// === EKS === ArgoCD ===

new k8s.helm.v3.Release(
  nm('argocd'),
  {
    name: 'argocd',
    chart: 'argo-cd',
    version: '7.1.0',
    namespace: 'argocd',
    repositoryOpts: {
      repo: 'https://argoproj.github.io/argo-helm',
    },
    values: {
      configs: {
        repositories: {
          sdp: {
            url: config.git.repo,
            username: config.git.username,
            password: config.git.password,
          },
        },
      },
      controller: {
        resources: {
          requests: {
            cpu: '200m',
            memory: '500Mi',
          },
          limits: {
            memory: '1Gi',
          },
        },
      },
    },
    createNamespace: true,
  },
  { provider },
)

// === EKS === External DNS === IAM ===

const externalDNSPolicyName = nm('external-dns-policy')
const externalDNSPolicy = new aws.iam.Policy(externalDNSPolicyName, {
  policy: aws.iam
    .getPolicyDocument({
      statements: [
        {
          effect: 'Allow',
          actions: ['route53:ChangeResourceRecordSets'],
          resources: ['arn:aws:route53:::hostedzone/*'],
        },
        {
          effect: 'Allow',
          actions: ['route53:ListHostedZones', 'route53:ListResourceRecordSets', 'route53:ListTagsForResource'],
          resources: ['*'],
        },
      ],
    })
    .then((doc) => doc.json),
})
const externalDNSRoleName = nm('external-dns-role')
const externalDNSRole = new aws.iam.Role(externalDNSRoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
new aws.iam.RolePolicyAttachment(externalDNSRoleName, {
  policyArn: externalDNSPolicy.arn,
  role: externalDNSRole,
})
new aws.eks.PodIdentityAssociation(nm('external-dns-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: 'external-dns',
  serviceAccount: 'external-dns',
  roleArn: externalDNSRole.arn,
})
new k8s.helm.v3.Release(
  nm('external-dns'),
  {
    name: 'external-dns',
    chart: 'external-dns',
    namespace: 'external-dns',
    version: '1.14.4',
    repositoryOpts: {
      repo: 'https://kubernetes-sigs.github.io/external-dns/',
    },
    values: {
      serviceAccount: {
        create: true,
        name: 'external-dns',
      },
    },
    createNamespace: true,
  },
  { provider },
)

// === EKS === Cert Manager ===

new k8s.helm.v3.Release(
  nm('cert-manager'),
  {
    name: 'cert-manager',
    chart: 'cert-manager',
    namespace: 'cert-manager',
    version: 'v1.14.5',
    repositoryOpts: {
      repo: 'https://charts.jetstack.io',
    },
    values: {
      installCRDs: true,
      prometheus: {
        enabled: true,
        servicemonitor: {
          enabled: true,
        },
      },
      enableCertificateOwnerRef: true,
      extraArgs: [
        '--enable-certificate-owner-ref=true',
        '--dns01-recursive-nameservers-only',
        '--dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53',
      ],
      securityContext: {
        fsGroup: 1001,
      },
    },
    createNamespace: true,
  },
  { provider },
)

const certManagerDns01Policy = new aws.iam.Policy(nm('cert-manager-dns01-policy'), {
  policy: aws.iam
    .getPolicyDocument({
      statements: [
        {
          effect: 'Allow',
          actions: ['route53:GetChange'],
          resources: ['arn:aws:route53:::change/*'],
        },
        {
          effect: 'Allow',
          actions: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets'],
          resources: ['arn:aws:route53:::hostedzone/*'],
        },
        {
          effect: 'Allow',
          actions: ['route53:ListHostedZonesByName'],
          resources: ['*'],
        },
      ],
    })
    .then((doc) => doc.json),
})
const certManagerDns01RoleName = nm('cert-manager-dns01-role')
const certManagerDns01Role = new aws.iam.Role(certManagerDns01RoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
new aws.iam.RolePolicyAttachment(nm('cert-manager-dns01-role-policy'), {
  policyArn: certManagerDns01Policy.arn,
  role: certManagerDns01Role,
})
new aws.eks.PodIdentityAssociation(nm('cert-manager-dns01-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: 'cert-manager',
  serviceAccount: 'cert-manager',
  roleArn: certManagerDns01Role.arn,
})

// === EKS === Monitoring ===

const monitoringNamespace = new k8s.core.v1.Namespace(
  nm('monitoring'),
  { metadata: { name: 'monitoring' } },
  { provider },
)

// === EKS === Monitoring === Metrics Server ===

new k8s.helm.v3.Release(
  nm('metrics-server'),
  {
    name: 'metrics-server',
    chart: 'metrics-server',
    namespace: monitoringNamespace.metadata.name,
    version: '3.12.1',
    repositoryOpts: {
      repo: 'https://kubernetes-sigs.github.io/metrics-server/',
    },
  },
  { provider },
)

// === EKS === Monitoring === Kube Prometheus Stack ===

new k8s.helm.v3.Release(
  nm('kube-prometheus-stack'),
  {
    name: 'kube-prometheus-stack',
    chart: 'kube-prometheus-stack',
    version: '59.1.0',
    namespace: monitoringNamespace.metadata.name,
    repositoryOpts: {
      repo: 'https://prometheus-community.github.io/helm-charts',
    },
    values: {
      prometheus: {
        prometheusSpec: {
          serviceMonitorSelectorNilUsesHelmValues: false,
          podMonitorSelectorNilUsesHelmValues: false,
          resources: {
            requests: {
              memory: '1Gi',
            },
            limits: {
              memory: '2Gi',
            },
          },
        },
      },
      prometheusOperator: {
        admissionWebhooks: {
          certManager: {
            enabled: true,
          },
        },
      },
      grafana: {
        persistence: {
          enabled: true,
        },
        adminPassword: config.grafana.password,
        'grafana.ini': {
          users: {
            viewers_can_edit: true,
          },
        },
        ingress: {
          enabled: true,
          hosts: [config.grafana.host],
          annotations: {
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod-issuer',
          },
          tls: [
            {
              secretName: 'grafana-tls',
              hosts: [config.grafana.host],
            },
          ],
        },
        dashboardProviders: {
          'dashboardproviders.yaml': {
            apiVersion: 1,
            providers: [
              {
                name: 'karperter',
                orgId: 1,
                folder: 'karpenter',
                type: 'file',
                disableDeletion: true,
                editable: true,
                options: {
                  path: '/var/lib/grafana/dashboards/karpenter',
                },
              },
            ],
          },
        },
        dashboards: {
          karpenter: {
            'karperter-capacity': {
              url: 'https://karpenter.sh/preview/getting-started/getting-started-with-karpenter/karpenter-capacity-dashboard.json',
            },
            'karperter-performance': {
              url: 'https://karpenter.sh/preview/getting-started/getting-started-with-karpenter/karpenter-performance-dashboard.json',
            },
          },
        },
      },
    },
  },
  { provider },
)

// === EKS === Monitoring === Loki ===

const lokiBuckets = ['chunks', 'ruler', 'admin']
const lokiBucketsEntries = lokiBuckets.map((lokiBucket) => {
  const bucket = nmo(`loki-${lokiBucket}`)
  new aws.s3.Bucket(bucket, {
    bucket,
    acl: 'private',
    serverSideEncryptionConfiguration: {
      rule: {
        applyServerSideEncryptionByDefault: {
          sseAlgorithm: 'AES256',
        },
      },
    },
  })
  return [lokiBucket, bucket]
})

const lokiUser = new aws.iam.User(nm('loki-user'))
const lokiAccessKey = new aws.iam.AccessKey(nm('loki-access-key'), {
  user: lokiUser.name,
})
const lokiS3AccessPolicy = new aws.iam.Policy(nm('loki-policy'), {
  policy: pulumi.all(lokiBucketsEntries).apply((buckets) =>
    aws.iam
      .getPolicyDocument({
        statements: [
          {
            effect: 'Allow',
            actions: ['s3:ListBucket'],
            resources: buckets.map(([, bucket]) => `arn:aws:s3:::${bucket}`),
          },
          {
            effect: 'Allow',
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
            resources: buckets.map(([, bucket]) => `arn:aws:s3:::${bucket}/*`),
          },
        ],
      })
      .then((doc) => doc.json),
  ),
})
new aws.iam.UserPolicyAttachment(nm('loki-user-policy'), {
  policyArn: lokiS3AccessPolicy.arn,
  user: lokiUser,
})

new k8s.helm.v3.Release(
  nm('loki'),
  {
    name: 'loki',
    chart: 'loki',
    version: '6.6.2',
    namespace: 'monitoring',
    repositoryOpts: {
      repo: 'https://grafana.github.io/helm-charts',
    },
    values: {
      chunksCache: {
        allocatedMemory: '1024',
        writebackSizeLimit: '64MB',
      },
      resultsCache: {
        allocatedMemory: '128',
        writebackSizeLimit: '64MB',
      },
      write: {
        resources: {
          requests: {
            memory: '256Mi',
          },
          limits: {
            memory: '512Mi',
          },
        },
      },
      loki: {
        auth_enabled: false,
        schemaConfig: {
          configs: [
            {
              from: '2024-04-01',
              store: 'tsdb',
              object_store: 's3',
              schema: 'v13',
              index: {
                prefix: 'loki_index_',
                period: '24h',
              },
            },
          ],
        },
        ingester: {
          chunk_encoding: 'snappy',
        },
        storage: {
          type: 's3',
          s3: {
            endpoint: 's3.amazonaws.com',
            region: regionId,
            secretAccessKey: lokiAccessKey.secret,
            accessKeyId: lokiAccessKey.id,
            s3ForcePathStyle: false,
            insecure: false,
          },
          bucketNames: Object.fromEntries(lokiBucketsEntries),
        },
      },
    },
  },
  { provider },
)

// === EKS === Monitoring === Promtail ===

new k8s.helm.v3.Release(
  nm('promtail'),
  {
    name: 'promtail',
    chart: 'promtail',
    version: '6.15.5',
    namespace: monitoringNamespace.metadata.name,
    repositoryOpts: {
      repo: 'https://grafana.github.io/helm-charts',
    },
    values: {
      config: {
        clients: [
          {
            url: 'http://loki-gateway/loki/api/v1/push',
          },
        ],
      },
    },
  },
  { provider },
)

// === EKS === External Secrets ===

const eso = new k8s.helm.v3.Release(
  nm('external-secrets'),
  {
    name: 'external-secrets',
    chart: 'external-secrets',
    version: '0.9.18',
    namespace: 'external-secrets',
    repositoryOpts: {
      repo: 'https://charts.external-secrets.io',
    },
    values: {
      installCRDs: true,
    },
    createNamespace: true,
  },
  { provider },
)

const esoSARole = new aws.iam.Role(nm('external-secrets-role'), {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
const esoRoleName = nm('external-secrets-operator-role')
const esoRole = new aws.iam.Role(esoRoleName, {
  assumeRolePolicy: {
    Version: '2012-10-17',
    Statement: [
      {
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Effect: 'Allow',
        Principal: {
          AWS: esoSARole.arn,
        },
      },
    ],
  },
})
const esoPolicyName = nm('external-secrets-policy')
const esoPolicy = new aws.iam.Policy(esoPolicyName, {
  policy: aws.iam
    .getPolicyDocument({
      statements: [
        {
          effect: 'Allow',
          actions: [
            'secretsmanager:GetResourcePolicy',
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret',
            'secretsmanager:ListSecretVersionIds',
            'secretsmanager:ListSecrets',
          ],
          resources: ['*'],
        },
      ],
    })
    .then((doc) => doc.json),
})
new aws.iam.RolePolicyAttachment(esoRoleName, {
  policyArn: esoPolicy.arn,
  role: esoRole,
})
new aws.eks.PodIdentityAssociation(nm('external-secrets-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: 'kube-system',
  serviceAccount: 'external-secrets',
  roleArn: esoSARole.arn,
})

new k8s.apiextensions.CustomResource(
  nm('aws-secrets-store'),
  {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ClusterSecretStore',
    metadata: {
      name: 'aws-secrets-store',
    },
    spec: {
      provider: {
        aws: {
          service: 'SecretsManager',
          region: regionId,
          role: esoRole.arn,
        },
      },
    },
  },
  { provider, dependsOn: [eso] },
)

// === EKS === EFS ===

const efs = new aws.efs.FileSystem(nm('efs'), {
  encrypted: true,
  kmsKeyId: kmsKey.arn,
  performanceMode: 'generalPurpose',
  throughputMode: 'elastic',
  tags: {
    Name: nm('efs'),
  },
})
privateSubnets.forEach((subnet, index) => {
  new aws.efs.MountTarget(nm(`efs-${index}`), {
    fileSystemId: efs.id,
    subnetId: subnet.id,
    securityGroups: [clusterSecurityGroupId],
  })
})
new k8s.storage.v1.StorageClass(
  nm('efs'),
  {
    metadata: {
      name: 'efs',
    },
    provisioner: 'efs.csi.aws.com',
    volumeBindingMode: 'WaitForFirstConsumer',
    parameters: {
      fileSystemId: efs.id,
      provisioningMode: 'efs-ap',
      directoryPerms: '755',
    },
  },
  { provider },
)

// === EKS === Kyverno ===

const kyverno = new k8s.helm.v3.Release(
  nm('kyverno'),
  {
    name: 'kyverno',
    chart: 'kyverno',
    version: '3.2.4',
    namespace: 'kyverno',
    repositoryOpts: {
      repo: 'https://kyverno.github.io/kyverno/',
    },
    createNamespace: true,
  },
  { provider },
)

// new k8s.helm.v3.Release(
//   nm('kyverno-policies'),
//   {
//     name: 'kyverno-policies',
//     chart: 'kyverno-policies',
//     version: '3.2.3 ',
//     namespace: kyverno.namespace,
//     repositoryOpts: {
//       repo: 'https://kyverno.github.io/kyverno/',
//     },
//   },
//   { provider },
// )

// === EKS === Kyverno === Policies ===

new k8s.apiextensions.CustomResource(
  nm('add-default-resources'),
  {
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    metadata: {
      name: 'add-default-resources',
      annotations: {
        'policies.kyverno.io/title': 'Add Default Resources',
        'policies.kyverno.io/category': 'Other',
        'policies.kyverno.io/severity': 'medium',
        'kyverno.io/kyverno-version': kyverno.version,
        'kyverno.io/kubernetes-version': eksCluster.version,
        'policies.kyverno.io/subject': 'Pod',
        'policies.kyverno.io/description': `Pods which don't specify at least resource requests are assigned a QoS class of BestEffort which can hog resources for other Pods on Nodes. At a minimum, all Pods should specify resource requests in order to be labeled as the QoS class Burstable. This sample mutates any container in a Pod which doesn't specify memory or cpu requests to apply some sane defaults.`,
      },
    },
    spec: {
      background: false,
      rules: [
        {
          name: 'add-default-requests-limits',
          match: {
            any: [
              {
                resources: {
                  kinds: ['Pod'],
                },
              },
            ],
          },
          preconditions: {
            any: [
              {
                key: '{{request.operation || "BACKGROUND"}}',
                operator: 'AnyIn',
                value: ['CREATE', 'UPDATE'],
              },
            ],
          },
          mutate: {
            foreach: [
              {
                list: 'request.object.spec.[ephemeralContainers, initContainers, containers][]',
                patchStrategicMerge: {
                  spec: {
                    containers: [
                      {
                        '(name)': '{{element.name}}',
                        resources: {
                          requests: {
                            '+(memory)': config.defaults.pod.resources.requests.memory,
                            '+(cpu)': config.defaults.pod.resources.requests.cpu,
                          },
                          limits: {
                            '+(memory)': config.defaults.pod.resources.limits.memory,
                            // NOTE: https://home.robusta.dev/blog/stop-using-cpu-limits
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },
  { provider, dependsOn: [kyverno] },
)

// === Exports ===

export const esoConfig = {
  clusterSecretStore: {
    aws: 'aws-secrets-store',
  },
}

// TODO: export all
export { kubeconfig, vpc, publicRouteTable, privateRouteTable, clusterSecurityGroupId }
