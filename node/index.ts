import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'

const config = new pulumi.Config()
const project = config.require('project')
const env = config.require('env')

const vpcName = `${project}-${env}-vpc`
const vpc = new aws.ec2.Vpc(vpcName, {
  cidrBlock: '10.0.0.0/16',
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: {
    Name: vpcName,
    Project: project
  }
})

const availabilityZones = await aws.getAvailabilityZones({ state: 'available' })
const publicSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = `${vpcName}-public-${index}`
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: true,
    tags: {
      Name: subnetName,
      Project: project
    }
  })
})
const privateSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = `${vpcName}-private-${index}`
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index + 10}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: false,
    tags: {
      Name: subnetName,
      Project: project
    }
  })
})

const internetGatewayName = `${vpcName}-igw`
const internetGateway = new aws.ec2.InternetGateway(internetGatewayName, {
  vpcId: vpc.id,
  tags: {
    Name: internetGatewayName,
    Project: project
  }
})

const publicRouteTableName = `${vpcName}-public-rt`
const publicRouteTable = new aws.ec2.RouteTable(publicRouteTableName, {
  vpcId: vpc.id,
  routes: [{
    cidrBlock: '0.0.0.0/0',
    gatewayId: internetGateway.id
  }],
  tags: {
    Name: publicRouteTableName,
    Project: project
  }
})

const publicSubnetAssociations = publicSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(`${publicRouteTableName}-assoc-${index}`, {
    routeTableId: publicRouteTable.id,
    subnetId: subnet.id
  })
})

const eipName = `${vpcName}-eip`
const eip = new aws.ec2.Eip(eipName, {
  domain: 'vpc',
  tags: {
    Name: eipName,
    Project: project
  }
})

const natGatewayName = `${vpcName}-nat-gw`
const natGateway = new aws.ec2.NatGateway(natGatewayName, {
  subnetId: publicSubnets[0].id,
  allocationId: eip.id,
  connectivityType: 'public',
  tags: {
    Name: natGatewayName,
    Project: project
  }
})

const privateRouteTableName = `${vpcName}-private-rt`
const privateRouteTable = new aws.ec2.RouteTable(privateRouteTableName, {
  vpcId: vpc.id,
  routes: [{
    cidrBlock: '0.0.0.0/0',
    natGatewayId: natGateway.id
  }],
  tags: {
    Name: privateRouteTableName,
    Project: project
  }
})

const privateSubnetAssociations = privateSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(`${privateRouteTableName}-assoc-${index}`, {
    routeTableId: privateRouteTable.id,
    subnetId: subnet.id
  })
})

const kmsKeyName = `${project}-${env}-kms`
const kmsKey = new aws.kms.Key(kmsKeyName, {
  description: 'KMS key for encrypting resources',
  deletionWindowInDays: 10,
  tags: {
    Name: kmsKeyName,
    Project: project
  }
})

const clusterVersion = '1.29'
const clusterName = `${project}-${env}-eks`
const cluster = new eks.Cluster(clusterName, {
  name: clusterName,
  version: clusterVersion,
  vpcId: vpc.id,
  createOidcProvider: true,
  publicSubnetIds: publicSubnets.map(s => s.id),
  privateSubnetIds: privateSubnets.map(s => s.id),
  encryptionConfigKeyArn: kmsKey.arn,
  nodeAssociatePublicIpAddress: false,
  defaultAddonsToRemove: ['kube-proxy'],
  nodeGroupOptions: {
    instanceType: 'm7g.large',
    desiredCapacity: 1,
    taints: {
      'node.cilium.io/agent-not-ready': {
        value: 'true',
        effect: 'NoExecute'
      }
    }
  },
  tags: {
    Name: clusterName,
    Project: project,
    'karpenter.sh/discovery': clusterName
  }
})
export const kubeconfig = cluster.kubeconfig

const k8sProvider = new k8s.Provider(clusterName, {
  kubeconfig: cluster.kubeconfigJson,
  enableServerSideApply: true
})

const awsNodeDaemonSetPatch = new k8s.apps.v1.DaemonSetPatch('disable-aws-node', {
  metadata: {
    namespace: 'kube-system',
    name: 'aws-node'
  },
  spec: {
    template: {
      spec: {
        nodeSelector: {
          'io.cilium/aws-node-enabled': 'true'
        }
      }
    }
  }
}, { provider: k8sProvider, retainOnDelete: true })

const gatewayAPIController = new k8s.yaml.ConfigFile('gateway-api-controller', {
  file: 'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.0.0/standard-install.yaml'
}, { provider: k8sProvider })

const k8sServiceHosts = k8s.core.v1.Endpoints.get('kubernetes-endpoint', 'kubernetes', { provider: k8sProvider }).subsets.apply(subsets =>
  subsets.map(subset => subset.addresses.map(address => address.ip)).flat()
)

const ciliumChartName = 'cilium'
const cilium = new k8s.helm.v3.Release(ciliumChartName, {
  chart: ciliumChartName,
  namespace: 'kube-system',
  repositoryOpts: {
    repo: 'https://helm.cilium.io'
  },
  values: {
    kubeProxyReplacement: 'strict',
    k8sServiceHost: k8sServiceHosts[0],
    ingressController: {
      enabled: true,
      loadbalancerMode: 'dedicated',
      default: true
    },
    hubble: {
      relay: {
        enabled: true
      },
      ui: {
        enabled: true
      }
    },
    loadBalancer: {
      algorithm: 'maglev',
      l7: {
        backend: 'envoy'
      }
    },
    gatewayAPI: {
      enabled: true
    },
    operator: {
      replicas: 1
    },
    routingMode: 'native',
    bpf: {
      masquerade: true
    },
    ipam: {
      mode: 'eni'
    },
    eni: {
      enabled: true,
      awsEnablePrefixDelegation: true
    }
  }
}, { provider: k8sProvider, dependsOn: [gatewayAPIController, awsNodeDaemonSetPatch] })

const coreDNSAddonName = 'coredns'
const coreDNSAddon = new aws.eks.Addon(coreDNSAddonName, {
  addonName: coreDNSAddonName,
  clusterName: cluster.eksCluster.name,
  addonVersion: (await aws.eks.getAddonVersion({
    addonName: coreDNSAddonName,
    kubernetesVersion: clusterVersion,
    mostRecent: true
  })).version,
  resolveConflictsOnCreate: 'OVERWRITE'
}, { dependsOn: [cilium] })

const vpcCniAddonName = 'vpc-cni'
const vpcCniAddon = new aws.eks.Addon(vpcCniAddonName, {
  addonName: vpcCniAddonName,
  clusterName: cluster.eksCluster.name,
  addonVersion: (await aws.eks.getAddonVersion({
    addonName: vpcCniAddonName,
    kubernetesVersion: clusterVersion,
    mostRecent: true
  })).version,
  resolveConflictsOnCreate: 'OVERWRITE'
}, { dependsOn: [cilium] })

const ebsCsiDriverRoleName = `${project}-${env}-ebs-csi-driver-irsa`
const ebsCsiDriverRole = new aws.iam.Role(ebsCsiDriverRoleName, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com'
  }),
  tags: {
    Name: ebsCsiDriverRoleName,
    Project: project
  }
})
const policyAttachment = new aws.iam.RolePolicyAttachment(`${ebsCsiDriverRoleName}-attachment`, {
  role: ebsCsiDriverRole,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy'
})
const csiDriverAddonName = 'aws-ebs-csi-driver'
const ebsCsiAddon = new aws.eks.Addon(csiDriverAddonName, {
  addonName: csiDriverAddonName,
  clusterName: cluster.eksCluster.name,
  addonVersion: (await aws.eks.getAddonVersion({
    addonName: csiDriverAddonName,
    kubernetesVersion: clusterVersion,
    mostRecent: true
  })).version,
  serviceAccountRoleArn: ebsCsiDriverRole.arn,
  resolveConflictsOnCreate: 'OVERWRITE'
}, { dependsOn: [cilium] })

// KarpenterNodeRole:
//   Type: "AWS::IAM::Role"
//   Properties:
//     RoleName: !Sub "KarpenterNodeRole-${ClusterName}"
//     Path: /
//     AssumeRolePolicyDocument:
//       Version: "2012-10-17"
//       Statement:
//         - Effect: Allow
//           Principal:
//             Service:
//               !Sub "ec2.${AWS::URLSuffix}"
//           Action:
//             - "sts:AssumeRole"
//     ManagedPolicyArns:
//       - !Sub "arn:${AWS::Partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
//       - !Sub "arn:${AWS::Partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy"
//       - !Sub "arn:${AWS::Partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
//       - !Sub "arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
const karpenterNodeRoleName = `${clusterName}-karpenter-node-role`
const karpenterNodeRole = new aws.iam.Role(karpenterNodeRoleName, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com'
  }),
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
    'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
    'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'
  ],
  tags: {
    Name: karpenterNodeRoleName,
    Project: project
  }
})

const karpenterInterruptionQueueName = `${clusterName}-karpenter-interruption-queue`
const karpenterInterruptionQueue = new aws.sqs.Queue(karpenterInterruptionQueueName, {
  name: karpenterInterruptionQueueName,
  messageRetentionSeconds: 300,
  sqsManagedSseEnabled: true,
  tags: {
    Name: karpenterInterruptionQueueName,
    Project: project
  }
})

const partitionId = await aws.getPartition().then(partition => partition.id)
const regionId = await aws.getRegion().then(region => region.id)
const accountId = await aws.getCallerIdentity().then(identity => identity.accountId)

const karpenterControllerPolicyName = `${clusterName}-karpenter-controller-policy`
const KarpenterControllerPolicy = new aws.iam.Policy(karpenterControllerPolicyName, {
  policy: await aws.iam.getPolicyDocument({
    statements: [
      {
        sid: 'AllowScopedEC2InstanceAccessActions',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}::image/*`,
          `arn:${partitionId}:ec2:${regionId}::snapshot/*`,
          `arn:${partitionId}:ec2:${regionId}:*:security-group/*`,
          `arn:${partitionId}:ec2:${regionId}:*:subnet/*`
        ],
        actions: [
          'ec2:RunInstances',
          'ec2:CreateFleet'
        ]
      },
      {
        sid: 'AllowScopedEC2LaunchTemplateAccessActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ec2:${regionId}:*:launch-template/*`],
        actions: [
          'ec2:RunInstances',
          'ec2:CreateFleet'
        ],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*']
          }
        ]
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
          `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`
        ],
        actions: [
          'ec2:RunInstances',
          'ec2:CreateFleet',
          'ec2:CreateLaunchTemplate'
        ],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.sh/nodepool',
            values: ['*']
          }
        ]
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
          `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`
        ],
        actions: ['ec2:CreateTags'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'ec2:CreateAction',
            values: ['RunInstances', 'CreateFleet', 'CreateLaunchTemplate']
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.sh/nodepool',
            values: ['*']
          }
        ]
      },
      {
        sid: 'AllowScopedResourceTagging',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ec2:${regionId}:*:instance/*`],
        actions: ['ec2:CreateTags'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*']
          },
          {
            test: 'ForAllValues:StringEquals',
            variable: 'aws:TagKeys',
            values: ['karpenter.sh/nodeclaim', 'Name']
          }
        ]
      },
      {
        sid: 'AllowScopedDeletion',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
          `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`
        ],
        actions: [
          'ec2:TerminateInstances',
          'ec2:DeleteLaunchTemplate'
        ],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*']
          }
        ]
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
          'ec2:DescribeSubnets'
        ],
        conditions: [
          {
            test: 'StringEquals',
            variable: 'aws:RequestedRegion',
            values: [regionId]
          }
        ]
      },
      {
        sid: 'AllowSSMReadActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ssm:${regionId}::parameter/aws/service/*`],
        actions: ['ssm:GetParameter']
      },
      {
        sid: 'AllowPricingReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['pricing:GetProducts']
      },
      {
        sid: 'AllowInterruptionQueueActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:sqs:${regionId}:${accountId}:${karpenterInterruptionQueueName}`],
        actions: [
          'sqs:DeleteMessage',
          'sqs:GetQueueUrl',
          'sqs:ReceiveMessage'
        ]
      },
      {
        sid: 'AllowPassingInstanceRole',
        effect: 'Allow',
        resources: [`arn:${partitionId}:iam::${accountId}:role/KarpenterNodeRole-${clusterName}`],
        actions: ['iam:PassRole'],
        conditions: [
          {
            test: 'StringEquals',
            variable: 'iam:PassedToService',
            values: ['ec2.amazonaws.com']
          }
        ]
      },
      {
        sid: 'AllowScopedInstanceProfileCreationActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:CreateInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringEquals',
            variable: 'aws:RequestTag/topology.kubernetes.io/region',
            values: [regionId]
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*']
          }
        ]
      },
      {
        sid: 'AllowScopedInstanceProfileTagActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:TagInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringEquals',
            variable: 'aws:ResourceTag/topology.kubernetes.io/region',
            values: [regionId]
          },
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringEquals',
            variable: 'aws:RequestTag/topology.kubernetes.io/region',
            values: [regionId]
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*']
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*']
          }
        ]
      },
      {
        sid: 'AllowScopedInstanceProfileActions',
        effect: 'Allow',
        resources: ['*'],
        actions: [
          'iam:AddRoleToInstanceProfile',
          'iam:RemoveRoleFromInstanceProfile',
          'iam:DeleteInstanceProfile'
        ],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${clusterName}`,
            values: ['owned']
          },
          {
            test: 'StringEquals',
            variable: 'aws:ResourceTag/topology.kubernetes.io/region',
            values: [regionId]
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*']
          }
        ]
      },
      {
        sid: 'AllowInstanceProfileReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:GetInstanceProfile']
      },
      {
        sid: 'AllowAPIServerEndpointDiscovery',
        effect: 'Allow',
        resources: [`arn:${partitionId}:eks:${regionId}:${accountId}:cluster/${clusterName}`],
        actions: ['eks:DescribeCluster']
      }
    ]
  }).then(policy => policy.json),
  tags: {
    Name: karpenterControllerPolicyName,
    Project: project
  }
})

const karpenterInterruptionQueuePolicyName = `${clusterName}-karpenter-interruption-queue-policy`
const KarpenterInterruptionQueuePolicy = new aws.sqs.QueuePolicy(karpenterInterruptionQueuePolicyName, {
  queueUrl: karpenterInterruptionQueue.id,
  policy: {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Service: ['events.amazonaws.com', 'sqs.amazonaws.com']
        },
        Action: 'sqs:SendMessage',
        Resource: karpenterInterruptionQueue.arn
      }
    ]
  }
})

const scheduledChangeRuleName = `${clusterName}-scheduled-change-rule`
const scheduledChangeRule = new aws.cloudwatch.EventRule(scheduledChangeRuleName, {
  name: scheduledChangeRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.health'],
    'detail-type': ['AWS Health Event']
  }),
  tags: {
    Name: scheduledChangeRuleName,
    Project: project
  }
})
const scheduledChangeTarget = new aws.cloudwatch.EventTarget(scheduledChangeRuleName, {
  rule: scheduledChangeRule.name,
  arn: karpenterInterruptionQueue.arn,
})

const spotInterruptionRuleName = `${clusterName}-spot-interruption-rule`
const spotInterruptionRule = new aws.cloudwatch.EventRule(spotInterruptionRuleName, {
  name: spotInterruptionRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Spot Instance Interruption Warning']
  }),
  tags: {
    Name: spotInterruptionRuleName,
    Project: project
  }
})
const spotInterruptionTarget = new aws.cloudwatch.EventTarget(spotInterruptionRuleName, {
  rule: spotInterruptionRule.name,
  arn: karpenterInterruptionQueue.arn,
})

const rebalanceRuleName = `${clusterName}-rebalance-rule`
const rebalanceRule = new aws.cloudwatch.EventRule(rebalanceRuleName, {
  name: rebalanceRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance Rebalance Recommendation']
  }),
  tags: {
    Name: rebalanceRuleName,
    Project: project
  }
})
const rebalanceTarget = new aws.cloudwatch.EventTarget(rebalanceRuleName, {
  rule: rebalanceRule.name,
  arn: karpenterInterruptionQueue.arn,
})

const instanceStateChangeRuleName = `${clusterName}-instance-state-change-rule`
const instanceStateChangeRule = new aws.cloudwatch.EventRule(instanceStateChangeRuleName, {
  name: instanceStateChangeRuleName,
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance State-change Notification']
  }),
  tags: {
    Name: instanceStateChangeRuleName,
    Project: project
  }
})
const instanceStateChangeTarget = new aws.cloudwatch.EventTarget(instanceStateChangeRuleName, {
  rule: instanceStateChangeRule.name,
  arn: karpenterInterruptionQueue.arn,
})
