import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';
import { SesCreds } from './ses-creds';

interface Props extends cdk.StackProps {
  domainName: string;
  hostedZone?: string;
  accountDomain?: string;
  certificateArn?: string;
  enableExecute?: boolean;
}

export class GoToSocialStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    {
      domainName,
      hostedZone,
      accountDomain,
      certificateArn,
      enableExecute = true,
      ...props
    }: Props
  ) {
    super(scope, id, props);

    const domainZone = route53.HostedZone.fromLookup(this, 'domainZone', {
      domainName: hostedZone ?? domainName,
    });

    const s3User = new iam.User(this, 's3user');
    const s3Key = new iam.AccessKey(this, 's3key', {
      user: s3User,
      status: iam.AccessKeyStatus.ACTIVE,
    });
    const s3KeyAccess = new ssm.StringParameter(this, 's3KeyAccess', {
      parameterName: '/gts/s3/access',
      stringValue: s3Key.accessKeyId,
    });
    const s3KeySecret = new ssm.StringParameter(this, 's3KeySecret', {
      parameterName: '/gts/s3/secret',
      stringValue: s3Key.secretAccessKey.unsafeUnwrap(),
    });

    const dataBucket = new s3.Bucket(this, 'dataBucket', {
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    dataBucket.grantReadWrite(s3User);

    const vpc = new ec2.Vpc(this, 'gtsVpc', {
      maxAzs: 3,
      natGateways: 1,
      natGatewayProvider: ec2.NatProvider.instance({
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T4G,
          ec2.InstanceSize.NANO
        ),
      }),
      subnetConfiguration: [
        {
          subnetType: ec2.SubnetType.PUBLIC,
          name: 'public',
        },
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          name: 'inside',
        },
        {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          name: 'private',
        },
      ],
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'dbSecurity', {
      vpc,
      allowAllOutbound: false,
    });
    const db = new rds.DatabaseInstance(this, 'db', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_14,
      }),
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(7),
      databaseName: 'gotosocial',
      storageEncrypted: true,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
    });
    const sesCreds = new SesCreds(this, 'sesCreds', {
      parameterPrefix: '/gts/smtp',
    });
    const emailConfigurationSet = new ses.ConfigurationSet(
      this,
      'emailConfigurationSet',
      {
        suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
        tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
        sendingEnabled: true,
      }
    );
    const emailIdentity = new ses.EmailIdentity(this, 'emailIdentity', {
      mailFromDomain: domainName,
      identity: ses.Identity.publicHostedZone(domainZone),
      configurationSet: emailConfigurationSet,
    });

    const environment: Record<string, string> = {
      GTS_HOST: domainName,
      GTS_ACCOUNT_DOMAIN: accountDomain ?? '',
      GTS_PROTOCOL: 'https',
      GTS_TRUSTED_PROXIES: vpc.vpcCidrBlock,
      GTS_PORT: '8080',
      GTS_DB_TYPE: 'postgres',
      GTS_DB_ADDRESS: db.instanceEndpoint.hostname,
      GTS_DB_PORT: db.instanceEndpoint.port.toString(),
      GTS_DB_TLS_MODE: 'enable',
      GTS_STORAGE_BACKEND: 's3',
      GTS_STORAGE_S3_BUCKET: dataBucket.bucketName,
      GTS_STORAGE_S3_ACCESS_KEY: s3KeyAccess.stringValue,
      GTS_STORAGE_S3_ENDPOINT: `s3.${this.region}.amazonaws.com`,
      GTS_LETSENCRYPT_ENABLED: 'false',
      GTS_LETSENCRYPT_EMAIL_ADDRESS: '',
      GTS_SMTP_HOST: `email-smtp.${this.region}.amazonaws.com`,
      GTS_SMTP_PORT: '587',
      GTS_SMTP_FROM: `admin@${domainName}`,
    };

    const secrets: Record<string, ecs.Secret> = {
      GTS_DB_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
      GTS_DB_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
      GTS_STORAGE_S3_SECRET_KEY: ecs.Secret.fromSsmParameter(s3KeySecret),
      GTS_SMTP_USERNAME: ecs.Secret.fromSsmParameter(
        sesCreds.usernameParameter
      ),
      GTS_SMTP_PASSOWRD: ecs.Secret.fromSsmParameter(
        sesCreds.passwordParameter
      ),
    };

    const cluster = new ecs.Cluster(this, 'cluster', { vpc });

    const taskSecurityGroup = new ec2.SecurityGroup(this, 'taskSecurity', {
      vpc,
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(
      taskSecurityGroup,
      ec2.Port.tcp(db.instanceEndpoint.port)
    );

    const certificate: acm.ICertificate | undefined = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'cert', certificateArn)
      : undefined;

    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      'service',
      {
        cluster,
        taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        cpu: 512,
        desiredCount: 1,
        memoryLimitMiB: 2048,
        publicLoadBalancer: true,
        targetProtocol: ApplicationProtocol.HTTP,
        protocol: ApplicationProtocol.HTTPS,
        redirectHTTP: true,
        domainName,
        domainZone,
        certificate,
        openListener: true,
        securityGroups: [taskSecurityGroup],
        enableExecuteCommand: enableExecute,
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry(
            'superseriousbusiness/gotosocial:latest'
          ),
          logDriver: ecs.LogDriver.awsLogs({
            logRetention: 180,
            mode: ecs.AwsLogDriverMode.NON_BLOCKING,
            streamPrefix: 'gts',
          }),
          containerName: 'gotosocial',
          containerPort: 8080,
          environment,
          secrets,
        },
      }
    );

    service.taskDefinition.node.addDependency(
      db,
      ...sesCreds.dependencies,
      emailIdentity
    );
  }
}
