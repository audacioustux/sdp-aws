import * as aws from '@pulumi/aws'

export function assumeRoleForEKSPodIdentity(): aws.iam.PolicyDocument {
	return {
		Version: '2012-10-17',
		Statement: [
			{
				Sid: 'AllowEksAuthToAssumeRoleForPodIdentity',
				Effect: 'Allow',
				Principal: {
					Service: 'pods.eks.amazonaws.com',
				},
				Action: ['sts:AssumeRole', 'sts:TagSession'],
			},
		],
	}
}
