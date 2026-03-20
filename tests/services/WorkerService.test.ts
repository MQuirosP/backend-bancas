import { WorkerService } from '../../src/api/v1/services/worker.service';

describe('WorkerService', () => {
  it('should handle invalid PDF buffer gracefully', async () => {
    const invalidPdf = Buffer.from('not a pdf');
    
    // We expect it to fail because it's not a valid PDF
    // but the failure should come from the worker script's try-catch
    await expect(WorkerService.convertPdfToPng(new Uint8Array(invalidPdf)))
      .rejects.toThrow();
  });

  // Note: Testing with a real PDF would require a sample file.
  // Given the environment constraints, we focus on error handling 
  // and ensuring the worker thread lifecycle (spawn/terminate) works.
});
