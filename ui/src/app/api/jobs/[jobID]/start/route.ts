import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import path from 'path';
import fs from 'fs';
import { getTrainingFolder } from '@/server/settings';
import { randomUUID } from 'crypto';

interface HistoryEntry {
  id: string;
  timestamp: string;
  step_at_start: number;
  config: unknown;
}

const appendHistoryEntry = async (jobName: string, entry: HistoryEntry): Promise<void> => {
  const trainingFolder = await getTrainingFolder();
  const historyPath = path.join(trainingFolder, jobName, 'training_history.json');
  await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });

  let history: HistoryEntry[] = [];
  try {
    const raw = await fs.promises.readFile(historyPath, 'utf-8');
    history = JSON.parse(raw);
  } catch {
    // no history yet
  }
  history.push(entry);
  await fs.promises.writeFile(historyPath, JSON.stringify(history, null, 2), 'utf-8');
};

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // record a history snapshot for this run start
  try {
    await appendHistoryEntry(job.name, {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      step_at_start: job.step,
      config: JSON.parse(job.job_config),
    });
  } catch (err) {
    console.error('Failed to write training history entry:', err);
  }

  // get highest queue position
  const highestQueuePosition = await prisma.job.aggregate({
    _max: {
      queue_position: true,
    },
  });
  const newQueuePosition = (highestQueuePosition._max.queue_position || 0) + 1000;

  await prisma.job.update({
    where: { id: jobID },
    data: { queue_position: newQueuePosition },
  });

  // make sure the queue is running
  const queue = await prisma.queue.findFirst({
    where: {
      gpu_ids: job.gpu_ids,
    },
  });

  // if queue doesn't exist, create it
  if (!queue) {
    await prisma.queue.create({
      data: {
        gpu_ids: job.gpu_ids,
        is_running: false,
      },
    });
  }

  await prisma.job.update({
    where: { id: jobID },
    data: {
      status: 'queued',
      stop: false,
      return_to_queue: false,
      info: 'Job queued',
    },
  });

  // Return the response immediately
  return NextResponse.json(job);
}
