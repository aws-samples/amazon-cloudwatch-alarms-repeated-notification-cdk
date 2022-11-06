# © 2022 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
# This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
# http://aws.amazon.com/agreement or other written agreement between Customer and either
# Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
import json
import os
from typing import List
import datetime
import logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

import boto3

session = boto3.session.Session()
CW_CLIENT = session.client('cloudwatch')
SNS_CLIENT = session.client('sns')

SNS_SUBJECT_LIMIT = 100

def lambda_handler(event, context):
    """ Lambda entrypoint for the CheckAlarmStatus Lambda Function """
    logger.info(event)

    # Set the default alarm status response as null
    event.update({"currState": "null"})

    try:
        # Retrieve the CloudWatch Alarm Name from the incoming event
        alarm_arn = event["resources"][0]
        alarm_name = event["detail"].get("alarmName")

        # Describe and check the tags on the CloudWatch Alarm
        # And See if the tag key used for repeated notification exists,
        # and has the correct value as defined in environment variable
        alarm_tags = CW_CLIENT.list_tags_for_resource(ResourceARN=alarm_arn)
        logger.info(alarm_tags)
        if check_if_repeated_alarm_enabled(alarm_tags.get("Tags")):
            alarm_response = CW_CLIENT.describe_alarms(
                AlarmNames=[alarm_name],
                AlarmTypes=["CompositeAlarm", "MetricAlarm"]
            )
            logger.info(alarm_response)

            if len(alarm_response.get("MetricAlarms")) >0:
                alarm_details = alarm_response.get("MetricAlarms")[0]
            elif len(alarm_response.get("CompositeAlarms")) > 0:
                alarm_details = alarm_response.get("CompositeAlarms")[0]

            alarm_details = json.loads(
                json.dumps(
                    alarm_details, default=datetime_converter
                )
            )

            if alarm_details.get("StateValue") == "ALARM":
                associated_alarm_actions = alarm_details.get("AlarmActions")
                for action in associated_alarm_actions:
                    if action.startswith(os.getenv("ARN_PREFIX")+"sns"):
                        # compose SNS notification subject and truncate if the subject is longer than 100 char limit
                        notification_subject = "ALARM: \""+alarm_name+"\" remains in ALARM state in "+session.region_name
                        if len(notification_subject) >= SNS_SUBJECT_LIMIT:
                            # If truncation is required, remove 4 additional char to allow use of "..."
                            number_of_char_to_remove = len(notification_subject) - SNS_SUBJECT_LIMIT + 4
                            # Recompose notification subject with a truncated alarm name
                            notification_subject = "ALARM: \""+alarm_name[:-number_of_char_to_remove]+"...\" remains in ALARM state in "+session.region_name
                        SNS_CLIENT.publish(
                            TopicArn = action,
                            Subject = notification_subject,
                            Message = json.dumps(alarm_details)
                        )
                        logger.info("Publish to %s" % action)
            event["currState"] = alarm_details.get("StateValue")
    except Exception as e:
        logger.error(f"Error: {repr(e)}")
        raise

    return event

def datetime_converter(field):
    """helper function to perform JSON dump on object containing datetime"""
    if isinstance(field, datetime.datetime):
        return field.__str__()

def check_if_repeated_alarm_enabled(tags: List[dict], expected_tag="TagForRepeatedNotification"):
    """
    This function takes a dict of existing tags' key-value pair and check if it contains the expected tag
        params:
            tags(List[dict]): a dict object containing existing tags' key-value pairs on a CloudWatch Alarm
            expected_tag (str): the name of environment variable contains the expected key-value pair

        return:
            bool
    """
    tag_to_check = os.getenv(expected_tag).split(":")
    key = tag_to_check[0]
    value = tag_to_check[1]
    for tag in tags:
        if tag.get("Key") == key and tag.get("Value") == value:
            return True
    return False

class CheckAlarmFailed(Exception):
    pass
