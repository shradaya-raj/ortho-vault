import Portal from './components/Portal';import{getOrthos}from'./lib/orthos';export default async function Home(){return <Portal orthos={await getOrthos()}/>}
