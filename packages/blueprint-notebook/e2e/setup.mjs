// Regression: provision a Python account and bind it entirely through the visible UI.
import {launch,newUserPage,signUp} from '../../blueprint-whiteboard/e2e/platform-helpers.mjs';
const browser=await launch();
try {
 const {page}=await newUserPage(browser);
 await signUp(page,'http://localhost:8797','setupcheck'+crypto.randomUUID().replaceAll('-',''),crypto.randomUUID());
 await page.goto('http://localhost:8797/outputs');
 await page.getByRole('button',{name:'New Notebook',exact:true}).click();
 await page.frameLocator('iframe[title="Gadget UI"]').getByLabel('Notebook title').waitFor();
 await page.getByRole('button',{name:'Connections',exact:true}).click();
 await page.getByRole('button',{name:'Connect resource',exact:true}).first().click();
 await page.getByRole('dialog').getByText('Notebook Python',{exact:true}).click();
 await page.getByText('Notebook Python kernel',{exact:true}).click();
 await page.getByRole('button',{name:'Connect Notebook Python',exact:true}).click();
 await page.frameLocator('iframe[title="Resource configurator"]').locator('input').waitFor();
 await page.getByRole('button',{name:'Add connection',exact:true}).click();
 await page.getByRole('dialog',{name:'Notebook Python kernel',exact:true}).waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Notebook',exact:true}).click();
 const notebook = page.frameLocator('iframe[title="Gadget UI"]');
 await notebook.locator('#stop:enabled').waitFor({timeout:60000});
 await notebook.locator('.run:enabled:not([hidden])').first().waitFor();
 console.log('PASS: fresh account connects Python through the UI; Run and Stop/reset are enabled.');
} finally {await browser.close();}
