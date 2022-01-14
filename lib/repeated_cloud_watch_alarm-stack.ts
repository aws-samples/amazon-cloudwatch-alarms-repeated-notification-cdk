import { PythonFunction } from '@aws-cdk/aws-lambda-python';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
import * as sfn from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as cdk from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as resourcegroups from '@aws-cdk/aws-resourcegroups';
import * as logs from '@aws-cdk/aws-logs';
import { join } from 'path';

export class RepeatedCloudWatchAlarmStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const alarmStateChangeEventRule = new events.Rule(
      this, "alarmStateChangeEventRule",
      {
        description: `Triggers the alarm process step function on alarm state change`,
        eventPattern: {
          source: ["aws.cloudwatch"],
          detailType: ["CloudWatch Alarm State Change"],
          detail: {
            state: {
              value: ["ALARM"]},
          },
        },
      }
    )

    const RepeatedNotificationPeriod = new cdk.CfnParameter(this, "RepeatedNotificationPeriod", {
      type: "Number",
      description: "The time in seconds between each repeated notification for an alarm.",
      default: 300});
    const TagForRepeatedNotification = new cdk.CfnParameter(this, "TagForRepeatedNotification", {
      type: "String",
      description: "The tag used to enable repeated notification. Input must be in key:value format",
      default: "RepeatedAlarm:true",
      allowedPattern: "^[a-zA-Z0-9]+:[a-zA-Z0-9]+$"});
    const RequireResourceGroup = new cdk.CfnParameter(this, "RequireResourceGroup", {
      type: "String",
      description: "Whether to create a tag-based resource group to monitor all CloudWatch Alarms with repeated notification enabled",
      default: "false",
      allowedValues: ["true","false"]});

    const checkAlarmStatusLambda = new PythonFunction(
      this,
      "checkAlarmStatusLambda",
      {
        entry: join(__dirname, "src", "check_alarm_status_lambda"),
        index: "index.py",
        handler: "lambda_handler",
        runtime: lambda.Runtime.PYTHON_3_8,
        environment: {
          ARN_PREFIX: `arn:${this.partition}:`,
          TagForRepeatedNotification: TagForRepeatedNotification.valueAsString
        }
      }
    )

    checkAlarmStatusLambda.addToRolePolicy(
      new iam.PolicyStatement(
        {
          actions: [
            "cloudwatch:DescribeAlarms",
            "cloudwatch:ListTagsForResource",
            "sns:Publish"
          ],
          resources: ["*"]
        }
      )
    )

    const checkAlarmStatusLambdaLogGroup = new logs.LogGroup(
      this, "checkAlarmStatusLambdaLogGroup",
      {
        logGroupName: `/aws/lambda/${checkAlarmStatusLambda.functionName}`,
        retention: logs.RetentionDays.ONE_WEEK
      }
    )

    const waitState = new sfn.Wait(
      this, "Wait X Seconds",
      {
        time: sfn.WaitTime.duration(cdk.Duration.seconds(RepeatedNotificationPeriod.valueAsNumber))
      }
    )

    const checkAlarmTagAndStatusTask = new tasks.LambdaInvoke(
      this,
      "Check alarm tag and status",
      {
        lambdaFunction: checkAlarmStatusLambda,
        payloadResponseOnly: true,
        resultPath: '$'
      }
    )

    const choiceState = new sfn.Choice(this, "Is alarm still in ALARM state?")
    choiceState.when(
      sfn.Condition.stringEquals(`$.currState`, "ALARM"),
      waitState
    )
    choiceState.otherwise(
      new sfn.Succeed(this, "Alarm is not in ALARM state anymore")
    )

    waitState.next(checkAlarmTagAndStatusTask)
      .next(choiceState)

    const checkAlarmStatusSfn = new sfn.StateMachine(
      this,
      "checkAlarmStatusSfn",
      {
        definition: waitState
      }
    )

    alarmStateChangeEventRule.addTarget(
      new targets.SfnStateMachine(checkAlarmStatusSfn)
    )

    // Resource Group for monitoring alarms with repeated notification enabled
    const repeatedAlarmsGroup = new resourcegroups.CfnGroup(this, 'repeatedAlarmsGroup', {
      name: 'repeatedAlarmsGroup',
      description: 'A tag-based resource group to monitor all CloudWatch Alarms with repeated notification enabled',
      resourceQuery: {
        type: "TAG_FILTERS_1_0",
        query: {
          resourceTypeFilters: ['AWS::CloudWatch::Alarm'],
          tagFilters: [{
            key: cdk.Fn.select(0, cdk.Fn.split(":", TagForRepeatedNotification.valueAsString)),
            values: [cdk.Fn.select(1, cdk.Fn.split(":", TagForRepeatedNotification.valueAsString))],
          }],
        },
      },
    });
    repeatedAlarmsGroup.cfnOptions.condition = new cdk.CfnCondition(
      this, 'requireResourceGroupCondition', {
        expression: cdk.Fn.conditionEquals(RequireResourceGroup.valueAsString, 'true'),
      }
    );
  }
}
