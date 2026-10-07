import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  const base = `http://localhost:${port}`;
  console.log(`castellan example listening on ${base}`);
  console.log('Users: tina (technician), sam (site-manager), olga (org-admin) in org north; tara, sven in org south');
  console.log('Try:');
  console.log(`  curl -H 'x-user: tina' ${base}/work-orders`);
  console.log(`  curl -H 'x-user: tina' ${base}/work-orders/2            # 200 (read is site-wide)`);
  console.log(`  curl -X PATCH -H 'x-user: tina' -H 'content-type: application/json' -d '{"status":"closed"}' ${base}/work-orders/2/status   # 403 (not assigned)`);
  console.log(`  curl -X DELETE -H 'x-user: olga' ${base}/work-orders/5   # 403 (invoiced)`);
  console.log(`  curl -H 'x-user: tina' ${base}/me/permissions`);
}

void bootstrap();
