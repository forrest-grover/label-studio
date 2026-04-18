"""Daily janitor for orphaned tus temp files (TUS-003).

Intended to run once per day (03:00 UTC recommended) via OS cron or a
Kubernetes CronJob. Label Studio does not ship an in-process periodic scheduler
(rq-scheduler is not a dependency), so the scheduling is deferred to the
deployment layer.

Example k8s CronJob schedule: ``0 3 * * *``
Example crontab line::

    0 3 * * *  cd /app && python label_studio/manage.py cleanup_tus_orphans

The command also enqueues onto the ``low`` rq queue when Redis is available so
that the work happens off the web dyno; otherwise it runs inline.
"""

import logging

from core.redis import start_job_async_or_sync
from data_import.tus_app.janitor import cleanup_orphaned_tus_files
from django.core.management.base import BaseCommand

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Delete orphaned tus .meta/.data pairs older than TUS_ORPHAN_TTL_DAYS.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--sync',
            action='store_true',
            help='Run inline in this process instead of enqueuing on the rq low queue.',
        )

    def handle(self, *args, **options):
        if options['sync']:
            result = cleanup_orphaned_tus_files()
            self.stdout.write(self.style.SUCCESS(f'tus janitor: {result}'))
            return

        # start_job_async_or_sync falls back to synchronous execution when Redis
        # is unavailable (OSS default), so this works in every deployment.
        start_job_async_or_sync(cleanup_orphaned_tus_files, queue_name='low')
        self.stdout.write(self.style.SUCCESS('tus janitor: job dispatched'))
