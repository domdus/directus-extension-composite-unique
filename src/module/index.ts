import { defineModule } from '@directus/extensions-sdk';
import { userHasAdminAccess } from '../shared/admin';
import WizardView from './wizard-view.vue';
import ConstraintsView from './constraints-view.vue';

export default defineModule({
	id: 'composite-unique',
	name: 'Composite Unique',
	icon: 'key',
	routes: [
		{
			path: '',
			component: WizardView,
		},
		{
			path: 'constraints',
			component: ConstraintsView,
		},
	],
	preRegisterCheck(user) {
		return userHasAdminAccess(user);
	},
});
