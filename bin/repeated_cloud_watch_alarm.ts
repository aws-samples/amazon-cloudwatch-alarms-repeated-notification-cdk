#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import { RepeatedCloudWatchAlarmStack } from '../lib/repeated_cloud_watch_alarm-stack';

const app = new cdk.App();
new RepeatedCloudWatchAlarmStack(app, 'RepeatedCloudWatchAlarmStack');
