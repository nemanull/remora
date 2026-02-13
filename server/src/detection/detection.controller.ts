import { Controller } from '@nestjs/common';
import { DetectionService } from './detection.service';

@Controller('detection')
export class DetectionController {
  constructor(private readonly detectionService: DetectionService) {}
}
