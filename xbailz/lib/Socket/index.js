import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
import { makeInteropSocket } from './interop.js'
import { makePrivacySocket } from './privacy.js'
import { makeGraphQLSocket } from './graphql.js'
import { makeMessageBuilderSocket } from './message-builder.js'
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    const satu = makeCommunitiesSocket(newConfig);
    const dua = makeInteropSocket(satu);
    const tiga = makePrivacySocket(dua);
    const empat = makeGraphQLSocket(tiga);
    return makeMessageBuilderSocket(empat);
};
export default makeWASocket;
//# sourceMappingURL=index.js.map