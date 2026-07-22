import { HumanReplyService } from './services/humanReplyService';
import { AdapterFactory } from './adapters/AdapterFactory';

async function testReply() {
  const dbAdapter = AdapterFactory.getAdapter();
  const humanReply = new HumanReplyService(dbAdapter);

  console.log('Sending test reply to conversation 11...');
  const res = await humanReply.sendReply('11', 'สวัสดีครับ ทดสอบส่งข้อความจากระบบ Admin UI เข้า LINE ของคุณ');
  console.log('Result:', res);

  await (dbAdapter as any).pool?.end();
}

testReply().catch(e => console.error('Test reply error:', e));
