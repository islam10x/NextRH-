// Quick script to generate bcrypt password hash
// Run with: npx ts-node create-password-hash.ts

import * as bcrypt from 'bcryptjs';

async function generateHash() {
    const password = 'Admin123!'; // Change this to your desired password
    const hash = await bcrypt.hash(password, 10);
    console.log('\n=== Password Hash Generated ===');
    console.log('Password:', password);
    console.log('Hash:', hash);
    console.log('\nCopy the hash above and use it in your SQL insert statement.');
}

generateHash();
